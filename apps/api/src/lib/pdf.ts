/**
 * A very small PDF writer: A4 pages of monospaced text, no images, no dependency. Enough for a tax invoice,
 * a credit note or a remittance advice that must be a file a client or an accountant can open and keep.
 */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const LINE_H = 14;
const FONT_SIZE = 10;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LINE_H);

const escapeText = (s: string) =>
  s
    .replace(/[^\x20-\x7e]/g, (c) => (c === " " ? " " : "?")) // WinAnsi-safe subset; Arabic comes with O9
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

export function textPdf(lines: string[], title = "Document"): Buffer {
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };
  const catalogNo = add(""); // placeholder, filled after pages are known
  const pagesNo = add("");
  const fontNo = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const infoNo = add(`<< /Title (${escapeText(title)}) /Producer (Tasees platform) >>`);
  const pageNos: number[] = [];
  for (const page of pages) {
    const content = [
      "BT",
      `/F1 ${FONT_SIZE} Tf`,
      `${LINE_H} TL`,
      `${MARGIN} ${PAGE_H - MARGIN} Td`,
      ...page.map((l) => `(${escapeText(l)}) Tj T*`),
      "ET",
    ].join("\n");
    const contentNo = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    const pageNo = add(`<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontNo} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    pageNos.push(pageNo);
  }
  objects[catalogNo - 1] = `<< /Type /Catalog /Pages ${pagesNo} 0 R >>`;
  objects[pagesNo - 1] = `<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNos.length} >>`;

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Right-align a money string into a fixed-width column, for table rows in a text PDF. */
export const col = (left: string, right: string, width = 78) => `${left}${" ".repeat(Math.max(1, width - left.length - right.length))}${right}`;
