import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localStorage, memoryStorage, s3Storage, signV4, storageFromEnv, type Storage } from "../src/lib/storage.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGAGEMENT = "0f6a3e2e-5b1e-4d7a-9c3b-1a2b3c4d5e6f";

/**
 * AWS's published Signature Version 4 example for S3 ("GET Object" with a Range header), from the S3 API
 * reference "Examples: Signature Calculations in AWS Signature Version 4". If this ever fails, the signing
 * algorithm is wrong, whatever the fake server below says.
 */
describe("AWS Signature Version 4", () => {
  it("reproduces the AWS GET Object test vector", () => {
    const out = signV4({
      method: "GET",
      path: "/test.txt",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(out.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(out.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("reproduces the AWS PUT Object test vector", () => {
    // Same reference, "PUT Object" example: body "Welcome to Amazon S3." with storage class and date headers.
    const out = signV4({
      method: "PUT",
      path: "/test%24file.text",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(out.signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });
});

/**
 * A loopback stand-in for an S3 bucket. It stores objects, checks the payload hash, insists on server-side
 * encryption for every upload, and recomputes the signature from the request it actually received with the
 * shared secret, so a header we sign but do not send fails here. It reuses signV4, so only the two AWS
 * vectors above prove the algorithm itself; this proves the wire format and the round trip. A real bucket in
 * staging is still the final check.
 */
function fakeS3(secret: { accessKeyId: string; secretAccessKey: string; region: string }) {
  const objects = new Map<string, Buffer>();
  const log: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const fail = (status: number, code: string) => {
      res.writeHead(status, { "content-type": "application/xml" });
      res.end(`<Error><Code>${code}</Code></Error>`);
    };
    const auth = String(req.headers.authorization ?? "");
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) return fail(403, "InvalidAuthorizationHeader");
    if (m[1] !== secret.accessKeyId) return fail(403, "InvalidAccessKeyId");
    const signed = m[4]!.split(";");
    const headers: Record<string, string> = {};
    for (const h of signed) {
      const v = headerOf(req, h);
      if (v === undefined) return fail(403, "SignedHeaderMissing:" + h);
      headers[h] = v;
    }
    const payloadHash = createHash("sha256").update(body).digest("hex");
    if (headers["x-amz-content-sha256"] !== payloadHash) return fail(400, "XAmzContentSHA256Mismatch");
    const url = new URL(req.url ?? "/", "http://x");
    const expected = signV4({
      method: req.method ?? "GET",
      path: url.pathname,
      headers,
      payloadHash,
      region: m[3]!,
      service: "s3",
      accessKeyId: m[1]!,
      secretAccessKey: secret.secretAccessKey,
      amzDate: headers["x-amz-date"]!,
    });
    if (expected.signature !== m[5]) return fail(403, "SignatureDoesNotMatch");
    if (m[3] !== secret.region) return fail(400, "AuthorizationHeaderMalformed");
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    log.push(`${req.method} ${key}`);
    if (req.method === "PUT") {
      if (!req.headers["x-amz-server-side-encryption"]) return fail(400, "ServerSideEncryptionRequired");
      objects.set(key, body);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "GET") {
      const o = objects.get(key);
      if (!o) return fail(404, "NoSuchKey");
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(o);
    }
    return fail(405, "MethodNotAllowed");
  });
  return { server, objects, log };
}

const headerOf = (req: IncomingMessage, name: string) => {
  if (name === "host") return req.headers.host;
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

describe("storage adapters", () => {
  const creds = { accessKeyId: "TESTKEYID", secretAccessKey: "test/secret+key", region: "me-central-1" };
  const fake = fakeS3(creds);
  let endpoint = "";
  let tmp = "";

  beforeAll(async () => {
    await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", () => r()));
    const addr = fake.server.address() as { port: number };
    endpoint = `http://127.0.0.1:${addr.port}`;
    tmp = await mkdtemp(join(tmpdir(), "tasees-storage-"));
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
    await rm(tmp, { recursive: true, force: true });
  });

  const adapters = (): Array<[string, () => Storage]> => [
    ["memory", () => memoryStorage()],
    ["local disk", () => localStorage(tmp)],
    ["s3 (fake bucket)", () => s3Storage({ ...creds, bucket: "tasees-evidence", endpoint, prefix: "evidence/" })],
  ];

  for (const [name, make] of adapters()) {
    describe(name, () => {
      it("stores and returns a file under the engagement's folder", async () => {
        const s = make();
        const key = await s.put(ENGAGEMENT, "trade licence.pdf", Buffer.from("%PDF-1.4 hello"));
        expect(key).toMatch(new RegExp(`^(evidence/)?${ENGAGEMENT}/[0-9a-f-]{36}-trade licence.pdf$`));
        expect((await s.get(key)).toString()).toBe("%PDF-1.4 hello");
        const again = await s.put(ENGAGEMENT, "trade licence.pdf", Buffer.from("second"));
        expect(again).not.toBe(key);
        expect((await s.get(again)).toString()).toBe("second");
      });

      it("refuses files of the wrong type or size and keys that escape their folder", async () => {
        const s = make();
        await expect(s.put(ENGAGEMENT, "virus.exe", Buffer.from("x"))).rejects.toThrow(/File type not allowed/);
        await expect(s.put(ENGAGEMENT, "big.pdf", Buffer.alloc(15 * 1024 * 1024 + 1))).rejects.toThrow(/larger than 15 MB/);
        await expect(s.put("../etc", "a.pdf", Buffer.from("x"))).rejects.toThrow(/bad engagement id/);
        await expect(s.get(`${ENGAGEMENT}/does-not-exist.pdf`)).rejects.toThrow(/not found|ENOENT|bad key/);
      });
    });
  }

  it("asks the bucket for server-side encryption on every upload and signs exactly what it sends", async () => {
    const s = s3Storage({ ...creds, bucket: "tasees-evidence", endpoint, prefix: "evidence/", sse: "AES256" });
    const key = await s.put(ENGAGEMENT, "report & summary (final).pdf", Buffer.from("content"));
    expect(fake.objects.has(`tasees-evidence/${key}`)).toBe(true);
    expect(fake.log.at(-1)).toBe(`PUT tasees-evidence/${key}`);
    expect((await s.get(key)).toString()).toBe("content");
  });

  it("reports the bucket's error code and rejects wrong credentials", async () => {
    const wrong = s3Storage({ ...creds, secretAccessKey: "nope", bucket: "tasees-evidence", endpoint });
    await expect(wrong.put(ENGAGEMENT, "a.pdf", Buffer.from("x"))).rejects.toThrow(/SignatureDoesNotMatch/);
    const otherRegion = s3Storage({ ...creds, region: "eu-west-1", bucket: "tasees-evidence", endpoint });
    await expect(otherRegion.put(ENGAGEMENT, "a.pdf", Buffer.from("x"))).rejects.toThrow(/AuthorizationHeaderMalformed/);
  });

  it("uses virtual-hosted addressing for AWS and path style for other endpoints", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url) + " host=" + ((init?.headers as Record<string, string>)?.host ?? "(none)"));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const aws = s3Storage({ ...creds, bucket: "mkw-evidence", fetchImpl });
    await aws.put(ENGAGEMENT, "a.pdf", Buffer.from("x"));
    expect(seen[0]).toMatch(/^https:\/\/mkw-evidence\.s3\.me-central-1\.amazonaws\.com\/[^ ]+ host=\(none\)$/);
    const other = s3Storage({ ...creds, bucket: "mkw-evidence", endpoint: "https://objects.example.ae", fetchImpl });
    await other.put(ENGAGEMENT, "a.pdf", Buffer.from("x"));
    expect(seen[1]).toMatch(/^https:\/\/objects\.example\.ae\/mkw-evidence\//);
  });

  it("is chosen from the environment and fails fast when a setting is missing", () => {
    expect(storageFromEnv({ STORAGE: "local", UPLOAD_DIR: tmp }).kind).toBe("local");
    expect(storageFromEnv({}).kind).toBe("local");
    expect(() => storageFromEnv({ STORAGE: "s3", S3_BUCKET: "b" })).toThrow(/needs accessKeyId/);
    expect(storageFromEnv({ STORAGE: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }).kind).toBe("s3");
  });
});
