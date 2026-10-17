import { createHash, createHmac } from "node:crypto";

/** AWS Signature Version 4, shared by the S3 storage adapter and the SES email transport. No SDK. */

export const sha256hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** URI-encode one path segment the way AWS expects: everything but unreserved characters, %XX in upper case. */
export function awsEncode(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface SignInput {
  method: string;
  /** Already-encoded canonical path, starting with "/". */
  path: string;
  /** Canonical query string (sorted, encoded), "" when none. */
  query?: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** ISO basic time stamp, for example 20130524T000000Z. */
  amzDate: string;
}

/** Pure function so it can be checked against AWS's published test vectors. */
export function signV4(input: SignInput): { authorization: string; signedHeaders: string; signature: string; canonicalRequest: string } {
  const date = input.amzDate.slice(0, 8);
  const headerList = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase().trim(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = headerList.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerList.map(([k]) => k).join(";");
  const canonicalRequest = [input.method.toUpperCase(), input.path, input.query ?? "", canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signedHeaders, signature, canonicalRequest };
}

export const amzDateOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Sign and send one request with the global fetch. Returns the raw response; callers read the body. */
export async function signedFetch(
  cfg: AwsCredentials & { region: string; service: string; now?: () => Date; fetchImpl?: typeof fetch },
  url: URL,
  init: { method: string; body?: Buffer | string; headers?: Record<string, string> },
): Promise<Response> {
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? Buffer.from(init.body, "utf8") : init.body;
  const payloadHash = sha256hex(body ?? "");
  const amzDate = amzDateOf((cfg.now ?? (() => new Date()))());
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(cfg.sessionToken ? { "x-amz-security-token": cfg.sessionToken } : {}),
    ...(init.headers ?? {}),
  };
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const { authorization } = signV4({ method: init.method, path: url.pathname, query, headers, payloadHash, region: cfg.region, service: cfg.service, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate });
  const { host: _h, ...sendHeaders } = headers;
  // A provider that hangs must not hold the queue: 20 seconds, then the call fails and is recorded as such.
  return (cfg.fetchImpl ?? fetch)(url.toString(), {
    method: init.method,
    headers: { ...sendHeaders, authorization },
    body: body as unknown as RequestInit["body"],
    signal: AbortSignal.timeout(20_000),
  });
}
