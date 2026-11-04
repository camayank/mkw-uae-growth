/**
 * Uploads are held until a malware scan finds them clean (E22). Every upload path stores its file through
 * `storeUpload()`, in the same transaction as the row that names it; every route that serves an uploaded file, and every
 * decision that relies on one, asks `assertUsable()` first. Only `clean` is served, and `not_scanned` when the owner
 * chose to serve unscanned files, labelled (T6, UPLOADS_UNSCANNED=allow). A pending, failed or infected file, or one with
 * no scan record at all, is held: a failed or missing scan never counts as clean.
 */
import { createHash } from "node:crypto";
import type { FileStatus } from "@tasees/core";
import { audit, type SessionUser } from "./context.ts";
import type { Database, Queryable } from "./db.ts";
import { asPlatform } from "./context.ts";
import { badRequest, cleanErrorText, conflict } from "./errors.ts";
import { scanWithin, type Scanner } from "./scanner.ts";
import { checkUpload, type Storage } from "./storage.ts";
import { transition } from "./transition.ts";

export interface UploadDeps {
  storage: Storage;
  /** null: no scanner configured (staging until T6). */
  scanner?: Scanner | null;
  /** The owner's choice under T6: serve files no scanner has looked at, labelled "not scanned". Off by default. */
  allowUnscanned?: boolean;
}

/** Scans that failed this many times stay failed (held) and wait for a person; the alert says so. */
export const MAX_SCAN_ATTEMPTS = 5;

/** Check, scan, store and record one upload. Returns the storage key. The row that names the file is the caller's. */
export async function storeUpload(tx: Queryable, deps: UploadDeps, actor: SessionUser | null, folder: string, fileName: string, data: Buffer): Promise<string> {
  let detected: string;
  try {
    detected = checkUpload(fileName, data);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  let status: FileStatus;
  let finding: string | null = null;
  let lastError: string | null = null;
  const scanner = deps.scanner ?? null;
  if (scanner) {
    try {
      const r = await scanWithin(scanner, data);
      status = r.verdict;
      finding = r.finding ?? null;
    } catch (e) {
      status = "failed";
      lastError = cleanErrorText((e as Error).message, 200);
    }
  } else {
    status = deps.allowUnscanned ? "not_scanned" : "pending";
  }
  let key: string;
  try {
    key = await deps.storage.put(folder, fileName, data);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const row = (
    await tx.query<{ id: string }>(
      `insert into file_scans (key, file_name, detected_type, size_bytes, sha256, uploaded_by, status, scanner, finding, attempts, last_error, scanned_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, case when $7 in ('clean', 'infected') then app_now() end) returning id`,
      [key, fileName, detected, data.length, createHash("sha256").update(data).digest("hex"), actor?.id ?? null, status, scanner?.name ?? null, finding, scanner ? 1 : 0, lastError],
    )
  ).rows[0]!;
  // The file name is personal data that erasure must be able to remove; the audit trail never changes, so it is not here.
  await audit(tx, actor, status === "clean" ? "file.received" : "file.held", "file", row.id, {
    status,
    detectedType: detected,
    sizeBytes: data.length,
    scanner: scanner?.name ?? null,
    ...(finding ? { finding } : {}),
  });
  return key;
}

const HELD: Record<string, string> = {
  pending: "This file has not been scanned for malware yet, so it is held. It opens once the scan finds it clean.",
  not_scanned: "This file has not been scanned for malware yet, so it is held. It opens once the scan finds it clean.",
  failed: "The malware scan of this file could not be done, so it is held. MKW Advisors is retrying the scan.",
  infected: "This file was refused by the malware scan and is held. Ask for a clean copy of the document.",
};

/** Whether a file's status may be served and relied on. */
export function usable(status: string | null | undefined, deps: Pick<UploadDeps, "allowUnscanned">): boolean {
  return status === "clean" || (status === "not_scanned" && !!deps.allowUnscanned);
}

/** Refuse (409) a file that is held, with the reason. Every key passed must be an upload's key. */
export async function assertUsable(tx: Queryable, deps: Pick<UploadDeps, "allowUnscanned">, keys: Array<string | null | undefined>, what = "This file"): Promise<void> {
  const list = keys.filter((k): k is string => !!k);
  if (!list.length) return;
  const rows = (await tx.query<{ key: string; status: string }>("select key, status from file_scans where key = any($1::text[])", [list])).rows;
  const byKey = new Map(rows.map((r) => [r.key, r.status]));
  for (const k of list) {
    const status = byKey.get(k) ?? "pending";
    if (!usable(status, deps)) {
      const reason = HELD[status] ?? HELD.pending!;
      throw conflict(what === "This file" ? reason : `${what}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
    }
  }
}

export interface ScanSweep {
  clean: number;
  infected: number;
  failed: number;
}

/**
 * The jobs step (`filesScanned`): scan what is held, oldest first. Pending and not_scanned files, and failed ones under
 * the attempt limit. Each verdict moves the file through its machine, audited; a scan that fails again counts the
 * attempt. Nothing happens while no scanner is configured.
 */
export async function scanHeldFiles(db: Database, deps: UploadDeps, limit = 50): Promise<ScanSweep> {
  const out: ScanSweep = { clean: 0, infected: 0, failed: 0 };
  const scanner = deps.scanner ?? null;
  if (!scanner) return out;
  const held = (
    await asPlatform(db, null, (tx) =>
      tx.query<{ id: string; key: string; status: FileStatus }>(
        `select id, key, status from file_scans
          where status in ('pending', 'not_scanned') or (status = 'failed' and attempts < $1)
          order by created_at limit $2`,
        [MAX_SCAN_ATTEMPTS, limit],
      ),
    )
  ).rows;
  for (const f of held) {
    let verdict: { verdict: "clean" | "infected"; finding?: string } | null = null;
    let error: string | null = null;
    try {
      verdict = await scanWithin(scanner, await deps.storage.get(f.key));
    } catch (e) {
      error = cleanErrorText((e as Error).message, 200);
    }
    await asPlatform(db, null, async (tx) => {
      await tx.query("update file_scans set attempts = attempts + 1 where id = $1", [f.id]);
      if (verdict) {
        await transition(tx, "file", f.id, verdict.verdict, "system", { set: { scanner: scanner.name, finding: verdict.finding ?? null, last_error: null } });
      } else if (f.status === "pending") {
        await transition(tx, "file", f.id, "failed", "system", { set: { scanner: scanner.name, last_error: error } });
      } else {
        await tx.query("update file_scans set last_error = $2 where id = $1", [f.id, error]);
      }
    });
    if (verdict) out[verdict.verdict] += 1;
    else out.failed += 1;
  }
  return out;
}

/** For the System page: the scanner, and the uploads by status. */
export async function uploadsOverview(tx: Queryable, deps: UploadDeps) {
  const rows = (await tx.query<{ status: string; n: number }>("select status, count(*)::int as n from file_scans group by status")).rows;
  const byStatus: Record<string, number> = { pending: 0, clean: 0, infected: 0, failed: 0, not_scanned: 0 };
  for (const r of rows) byStatus[r.status] = Number(r.n);
  const held = (
    await tx.query(
      `select f.id, f.file_name as "fileName", f.status, f.finding, f.attempts, f.last_error as "lastError", f.created_at::text as "createdAt"
         from file_scans f where f.status in ('pending', 'failed', 'infected', 'not_scanned') order by f.created_at desc limit 20`,
    )
  ).rows;
  return {
    scanner: { name: deps.scanner?.name ?? null, live: deps.scanner?.live ?? false },
    allowUnscanned: !!deps.allowUnscanned,
    byStatus,
    held,
  };
}
