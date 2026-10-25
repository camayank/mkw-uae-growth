import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { awsEncode, sha256hex, signV4 } from "./sigv4.ts";

/** Kept for the storage tests and anyone who imported them from here. */
export { signV4 };
export const s3Encode = awsEncode;
export type { SignInput } from "./sigv4.ts";

/**
 * Document storage behind one interface. Three adapters:
 *   memoryStorage()  the test double
 *   localStorage()   development: files on disk under UPLOAD_DIR
 *   s3Storage()      production: any S3-compatible object store (AWS me-central-1 for the UAE, or another
 *                    provider in a UAE region), signed with AWS Signature Version 4, server-side encryption on
 */
export interface Storage {
  put(engagementId: string, fileName: string, data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const MAX_BYTES = 15 * 1024 * 1024;
const EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "doc", "docx", "xls", "xlsx", "csv", "txt"];
const ALLOWED = new RegExp(`\\.(${EXTENSIONS.join("|")})$`, "i");

/** What any upload must be, as the page reads it before sending (O12) and as `checkUpload` enforces it. */
export const UPLOAD_RULES = { extensions: EXTENSIONS, maxBytes: MAX_BYTES } as const;

/** The same rules for every adapter: size, type, and a key that cannot escape its engagement folder. */
export function checkUpload(fileName: string, data: Buffer): void {
  if (data.length > MAX_BYTES) throw new Error("File is larger than 15 MB");
  if (!ALLOWED.test(fileName)) throw new Error("File type not allowed. Use PDF, image, Word, Excel, CSV or text.");
}

export function objectKey(engagementId: string, fileName: string, prefix = ""): string {
  if (!/^[0-9a-f-]{36}$/i.test(engagementId)) throw new Error("bad engagement id");
  const safe = fileName.replace(/[^\w.\- ]+/g, "_").slice(-120);
  return `${prefix}${engagementId}/${randomUUID()}-${safe}`;
}

export function localStorage(root = process.env.UPLOAD_DIR ?? "./data/uploads"): Storage {
  return {
    async put(engagementId, fileName, data) {
      checkUpload(fileName, data);
      const key = objectKey(engagementId, fileName);
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return key;
    },
    async get(key) {
      const path = normalize(join(root, key));
      if (!path.startsWith(normalize(root) + sep)) throw new Error("bad key");
      return readFile(path);
    },
  };
}

export function memoryStorage(): Storage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(engagementId, fileName, data) {
      checkUpload(fileName, data);
      const key = objectKey(engagementId, fileName);
      files.set(key, data);
      return key;
    },
    async get(key) {
      const f = files.get(key);
      if (!f) throw new Error("not found");
      return f;
    },
  };
}

// S3 ------------------------------------------------------------------------------------

export interface S3Config {
  bucket: string;
  /** AWS region used in the signature, for example me-central-1 (UAE). Other providers usually accept any value. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Service endpoint, for example https://s3.me-central-1.amazonaws.com. Default: AWS for the region. */
  endpoint?: string;
  /** Path-style addressing (https://endpoint/bucket/key). Default: on for a custom endpoint, off for AWS. */
  forcePathStyle?: boolean;
  /** Key prefix inside the bucket, for example "evidence/". */
  prefix?: string;
  /** Server-side encryption asked for on every upload. */
  sse?: "AES256" | "aws:kms";
  kmsKeyId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function s3Storage(cfg: S3Config): Storage {
  for (const k of ["bucket", "region", "accessKeyId", "secretAccessKey"] as const) if (!cfg[k]) throw new Error(`S3 storage needs ${k}`);
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const endpoint = new URL(cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`);
  const pathStyle = cfg.forcePathStyle ?? !!cfg.endpoint;
  const sse = cfg.sse ?? "AES256";
  const prefix = cfg.prefix ?? "";

  const amzDateOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const request = async (method: "PUT" | "GET", key: string, body?: Buffer, extra: Record<string, string> = {}) => {
    const encodedKey = key.split("/").map(s3Encode).join("/");
    const host = pathStyle ? endpoint.host : `${cfg.bucket}.${endpoint.host}`;
    const path = pathStyle ? `/${s3Encode(cfg.bucket)}/${encodedKey}` : `/${encodedKey}`;
    const payloadHash = sha256hex(body ?? "");
    const amzDate = amzDateOf((cfg.now ?? (() => new Date()))());
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(cfg.sessionToken ? { "x-amz-security-token": cfg.sessionToken } : {}),
      ...extra,
    };
    const { authorization } = signV4({ method, path, headers, payloadHash, region: cfg.region, service: "s3", accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate });
    const { host: _h, ...sendHeaders } = headers;
    const res = await fetchImpl(`${endpoint.protocol}//${host}${path}`, {
      method,
      headers: { ...sendHeaders, authorization },
      body: body as unknown as RequestInit["body"],
    });
    return res;
  };

  const errorOf = async (res: Response, what: string) => {
    const text = await res.text().catch(() => "");
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(res.status);
    return new Error(`${what} failed: ${code}`);
  };

  return {
    async put(engagementId, fileName, data) {
      checkUpload(fileName, data);
      const key = objectKey(engagementId, fileName, prefix);
      const res = await request("PUT", key, data, {
        "content-type": "application/octet-stream",
        "x-amz-server-side-encryption": sse,
        ...(sse === "aws:kms" && cfg.kmsKeyId ? { "x-amz-server-side-encryption-aws-kms-key-id": cfg.kmsKeyId } : {}),
      });
      if (!res.ok) throw await errorOf(res, "Storing the file");
      return key;
    },
    async get(key) {
      if (!key.startsWith(prefix)) throw new Error("bad key");
      const res = await request("GET", key);
      if (res.status === 404) throw new Error("not found");
      if (!res.ok) throw await errorOf(res, "Reading the file");
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** Pick the adapter from the environment. `STORAGE=s3` needs the S3_* variables; anything else is local disk. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): { storage: Storage; kind: "s3" | "local" } {
  if (env.STORAGE === "s3") {
    const storage = s3Storage({
      bucket: env.S3_BUCKET ?? "",
      region: env.S3_REGION ?? "me-central-1",
      accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
      sessionToken: env.S3_SESSION_TOKEN || undefined,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === "1" : undefined,
      prefix: env.S3_PREFIX ?? "",
      sse: env.S3_SSE === "aws:kms" ? "aws:kms" : "AES256",
      kmsKeyId: env.S3_KMS_KEY_ID || undefined,
    });
    return { storage, kind: "s3" };
  }
  return { storage: localStorage(env.UPLOAD_DIR ?? "./data/uploads"), kind: "local" };
}
