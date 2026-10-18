import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

/** Document storage. Local disk in development; swap for S3-compatible storage in production. */
export interface Storage {
  put(engagementId: string, fileName: string, data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = /\.(pdf|png|jpe?g|webp|docx?|xlsx?|csv|txt)$/i;

export function localStorage(root = process.env.UPLOAD_DIR ?? "./data/uploads"): Storage {
  return {
    async put(engagementId, fileName, data) {
      if (data.length > MAX_BYTES) throw new Error("File is larger than 15 MB");
      if (!ALLOWED.test(fileName)) throw new Error("File type not allowed. Use PDF, image, Word, Excel, CSV or text.");
      const safe = fileName.replace(/[^\w.\- ]+/g, "_").slice(-120);
      const key = `${engagementId}/${randomUUID()}-${safe}`;
      const path = join(root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return key;
    },
    async get(key) {
      const path = normalize(join(root, key));
      if (!path.startsWith(normalize(root))) throw new Error("bad key");
      return readFile(path);
    },
  };
}

export function memoryStorage(): Storage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(engagementId, fileName, data) {
      if (!ALLOWED.test(fileName)) throw new Error("File type not allowed. Use PDF, image, Word, Excel, CSV or text.");
      const key = `${engagementId}/${randomUUID()}-${fileName}`;
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
