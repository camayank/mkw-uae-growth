import { inflateRawSync } from "node:zlib";

/**
 * A minimal reader for .xlsx workbooks (O10): enough to read the go-live workbook's tabs as rows of text, with no
 * dependency. An .xlsx file is a zip of XML parts; this reads the zip's central directory, inflates the workbook,
 * its relationships, the shared strings and each sheet, and returns every sheet as a grid of strings (empty cells
 * are ""). Numbers come back as written in the file (a date is its serial number; see `excelDate`). Formulas are
 * read from their cached value. Entries are size-capped so a hostile file cannot exhaust memory.
 */

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not an .xlsx file (no zip directory found)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt .xlsx file (bad zip directory)");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): string {
  if (e.size > MAX_ENTRY_BYTES) throw new Error(`Workbook part ${e.name} is too large`);
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("Corrupt .xlsx file (bad zip entry)");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data.toString("utf8");
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString("utf8");
  throw new Error(`Unsupported compression in ${e.name}`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, g: string) => {
    if (g.startsWith("#x")) return String.fromCodePoint(parseInt(g.slice(2), 16));
    if (g.startsWith("#")) return String.fromCodePoint(parseInt(g.slice(1), 10));
    return ENTITIES[g] ?? m;
  });
}

/** Text of an <si> or <is> element: every <t>, skipping phonetic runs. */
function runText(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => xmlText(m[1] ?? "")).join("");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

export type Workbook = Map<string, string[][]>;

export function readXlsx(buf: Buffer): Workbook {
  const entries = zipEntries(buf);
  const part = (name: string) => {
    const e = entries.get(name.replace(/^\//, ""));
    return e ? readEntry(buf, e) : null;
  };
  const workbook = part("xl/workbook.xml");
  if (!workbook) throw new Error("Not an .xlsx workbook (xl/workbook.xml missing)");
  const rels = part("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sharedXml = part("xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]!)) : [];

  const out: Workbook = new Map();
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = xmlText(attr(m[0], "name") ?? "");
    const rid = attr(m[0], "r:id");
    const xml = rid && targets.get(rid) ? part(targets.get(rid)!) : null;
    if (!xml) continue;
    const grid: string[][] = [];
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const r = Number(attr(row[1] ?? row[3] ?? "", "r") ?? grid.length + 1) - 1;
      const cells: string[] = [];
      for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1] ?? "";
        const body = c[2] ?? "";
        const ref = attr(tag, "r") ?? "";
        const t = attr(tag, "t");
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = "";
        if (t === "s") value = shared[Number(v)] ?? "";
        else if (t === "inlineStr") value = runText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
        else value = v === undefined ? "" : xmlText(v);
        cells[ref ? colIndex(ref) : cells.length] = value;
      }
      grid[r] = Array.from({ length: cells.length }, (_, i) => cells[i] ?? "");
    }
    out.set(name, Array.from({ length: grid.length }, (_, i) => grid[i] ?? []));
  }
  return out;
}

/** A date cell as YYYY-MM-DD: ISO text as is, a serial number in the 1900 date system converted, else null. */
export function excelDate(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 1 || serial > 2_958_465) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // 31/01/2027, the UAE way of writing a date
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  return null;
}
