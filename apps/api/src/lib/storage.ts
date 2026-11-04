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

/** What a file's bytes say it is (E22): the formats' own signatures, never the name. */
export type DetectedType = "pdf" | "png" | "jpeg" | "webp" | "ole" | "docx" | "xlsx" | "zip" | "text" | "unknown";
const LABEL: Record<DetectedType, string> = {
  pdf: "a PDF",
  png: "a PNG image",
  jpeg: "a JPEG image",
  webp: "a WebP image",
  ole: "an old-style Office file (.doc or .xls)",
  docx: "a Word document in the .docx format",
  xlsx: "an Excel workbook in the .xlsx format",
  zip: "a ZIP archive",
  text: "plain text",
  unknown: "a file of another kind",
};

export function detectType(data: Buffer): DetectedType {
  const starts = (bytes: number[], at = 0) => bytes.every((b, i) => data[at + i] === b);
  // Readers accept a byte-order mark or other junk before the header, within the first kilobyte.
  if (data.subarray(0, 1024).indexOf("%PDF-") >= 0) return "pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpeg";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (starts([0x50, 0x4b, 0x03, 0x04])) {
    // An Office Open XML package names its parts in the archive's file headers. The package's own parts come first
    // (word/ or xl/); a workbook that embeds a Word document names word/ later, so the earliest decides.
    const word = data.indexOf("word/");
    const xl = data.indexOf("xl/");
    if (word >= 0 && (xl < 0 || word < xl)) return "docx";
    if (xl >= 0) return "xlsx";
    return "zip";
  }
  if (isText(data)) return "text";
  return "unknown";
}

/** UTF-8 with no binary control bytes (tab, line feed, form feed and carriage return are text). */
function isText(data: Buffer): boolean {
  for (const b of data) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** What each allowed extension's bytes must be, and the word for it in a refusal. */
const EXPECTED: Record<string, { type: DetectedType; word: string }> = {
  pdf: { type: "pdf", word: "a PDF" },
  png: { type: "png", word: "a PNG image" },
  jpg: { type: "jpeg", word: "a JPEG image" },
  jpeg: { type: "jpeg", word: "a JPEG image" },
  webp: { type: "webp", word: "a WebP image" },
  doc: { type: "ole", word: "a Word document" },
  xls: { type: "ole", word: "an Excel workbook" },
  docx: { type: "docx", word: "a Word document" },
  xlsx: { type: "xlsx", word: "an Excel workbook" },
  csv: { type: "text", word: "a CSV file" },
  txt: { type: "text", word: "a text file" },
};

/**
 * The same rules for every adapter: size, extension, and (E22) content that is what the extension says. Returns what
 * the bytes are. A key cannot escape its engagement folder (`objectKey`).
 */
export function checkUpload(fileName: string, data: Buffer): DetectedType {
  if (data.length > MAX_BYTES) throw new Error("File is larger than 15 MB");
  if (!ALLOWED.test(fileName)) throw new Error("File type not allowed. Use PDF, image, Word, Excel, CSV or text.");
  if (data.length === 0) throw new Error("The file is empty");
  const ext = fileName.toLowerCase().split(".").pop()!;
  const want = EXPECTED[ext]!;
  const got = detectType(data);
  if (got !== want.type) {
    throw new Error(`This file is named .${ext} but is not ${want.word}: its content is ${LABEL[got]}. Upload the document itself in its own format.`);
  }
  return got;
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
