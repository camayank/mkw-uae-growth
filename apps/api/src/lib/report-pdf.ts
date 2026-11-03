/**
 * E16 (D98): the UAE Entity Assessment Report as a designed PDF, in English or Arabic. A branded header, the status as
 * a banner, each section titled, its comparison as a table, every point's label as a coloured tag, the official
 * sources, and a footer with the reference and the page on every page. Arabic is drawn right to left with its letters
 * joined (pdfkit shapes them through fontkit); a line that mixes Arabic with English, numbers or addresses is laid out
 * by the Unicode bidirectional algorithm (bidi-js), run by run.
 *
 * The fonts are Noto Sans and Noto Sans Arabic (SIL Open Font License, `assets/fonts/OFL.txt`), embedded as subsets.
 * Returns the PDF and the text it drew, line by line, so tests can read what the document says.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import bidiFactory from "bidi-js";
import PDFDocument from "pdfkit";
import type { Report, ReportTable } from "@tasees/core";

const FONTS = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const bidi = bidiFactory();

const C = { brand: "#0f5c4d", brandInk: "#ffffff", gold: "#a8741a", goldBg: "#fbf3e2", okBg: "#e6f2ee", ink: "#1d1d1b", muted: "#5f5e58", line: "#d9d6cc", panel: "#f4f2ec", bad: "#9b2c2c", badBg: "#fbeaea", info: "#1f4e79", infoBg: "#e8f0f8" };
const PAGE = { w: 595.28, h: 841.89, margin: 48, footer: 40 };
const WIDTH = PAGE.w - 2 * PAGE.margin;

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const CONTROL = /[‎‏‪-‮⁦-⁩]/;
const CONTROLS = new RegExp(CONTROL.source, "g");
const NEUTRAL = /[\s.,:;!?()[\]"'«»،؛؟\-–—/·]/;

type Kind = "ar" | "la";
const kindOf = (ch: string): Kind | null => (ARABIC.test(ch) ? "ar" : NEUTRAL.test(ch) ? null : "la");

/** Tags the report puts on points, in both languages, with their colours. */
const TAG_STYLE: Array<[RegExp, string, string]> = [
  [/^(CHECKED|PASS|تم التحقق|مستوفى|verified rule|قاعدة متحقق منها)/, C.brand, C.okBg],
  [/^(DOES NOT FIT|لا يناسب)/, C.bad, C.badBg],
  [/^(CONDITION|TO CONFIRM|شرط|للتأكيد|SPECIALIST REVIEW|مراجعة مختص|ANSWERS TO CHECK|إجابات للمراجعة)/, C.info, C.infoBg],
  [/./, C.gold, C.goldBg],
];

/** The PDF's metadata: the title with the reference (never the recovery code) and the status, without direction marks. */
export const reportInfo = (r: Report) => ({ Title: `${r.title} ${r.reference}`.replace(CONTROLS, ""), Author: "MKW Advisors", Subject: r.statusLine.replace(CONTROLS, ""), Creator: "Tasees platform" });

export function reportPdf(r: Report): Promise<{ pdf: Buffer; text: string[] }> {
  const rtl = r.lang === "ar";
  const doc = new PDFDocument({ size: "A4", margins: { top: 0, bottom: 0, left: 0, right: 0 }, bufferPages: true, autoFirstPage: true, info: reportInfo(r) });
  doc.registerFont("la", join(FONTS, "NotoSans-Regular.ttf"));
  doc.registerFont("la-b", join(FONTS, "NotoSans-Bold.ttf"));
  doc.registerFont("ar", join(FONTS, "NotoSansArabic-Regular.ttf"));
  doc.registerFont("ar-b", join(FONTS, "NotoSansArabic-Bold.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const drawn: string[] = [];

  const font = (k: Kind, bold: boolean) => (k === "ar" ? (bold ? "ar-b" : "ar") : bold ? "la-b" : "la");
  /** Text split into runs of one script, for measuring and drawing; neutral characters join the run they sit in. */
  const scriptRuns = (s: string): Array<{ text: string; kind: Kind }> => {
    const out: Array<{ text: string; kind: Kind }> = [];
    for (const ch of s) {
      if (CONTROL.test(ch)) continue;
      const k = kindOf(ch) ?? out[out.length - 1]?.kind ?? (rtl ? "ar" : "la");
      const last = out[out.length - 1];
      if (last && last.kind === k) last.text += ch;
      else out.push({ text: ch, kind: k });
    }
    return out;
  };
  const measure = (s: string, size: number, bold: boolean) => scriptRuns(s).reduce((w, run) => w + doc.font(font(run.kind, bold)).fontSize(size).widthOfString(run.text), 0);

  /** One line in visual order: bidi levels, runs by level and script, reordered (rule L2), drawn left to right. */
  const drawLine = (line: string, x: number, y: number, width: number, size: number, bold: boolean, color: string, align: "left" | "right") => {
    const { levels } = bidi.getEmbeddingLevels(line, rtl ? "rtl" : "ltr");
    type Run = { text: string; level: number; kind: Kind };
    const runs: Run[] = [];
    let i = 0;
    for (const ch of line) {
      const level = levels[i]!;
      i += ch.length;
      if (CONTROL.test(ch)) continue;
      const last = runs[runs.length - 1];
      const k = kindOf(ch) ?? (last && last.level === level ? last.kind : rtl && level % 2 ? "ar" : "la");
      if (last && last.level === level && last.kind === k) last.text += ch;
      else runs.push({ text: ch, level, kind: k });
    }
    const max = Math.max(0, ...runs.map((r) => r.level));
    const lowestOdd = Math.min(...runs.map((r) => r.level).filter((l) => l % 2 === 1), max + 1);
    for (let lev = max; lev >= lowestOdd; lev--) {
      for (let s = 0; s < runs.length; ) {
        if (runs[s]!.level < lev) { s++; continue; }
        let e = s;
        while (e + 1 < runs.length && runs[e + 1]!.level >= lev) e++;
        runs.splice(s, e - s + 1, ...runs.slice(s, e + 1).reverse());
        s = e + 1;
      }
    }
    // A right-to-left (odd) run is placed word by word, last word first: the font engine shapes and orders the letters
    // inside a word that holds Arabic, but given a whole phrase it drops spaces. Brackets are mirrored; a word without
    // Arabic (a number, a sign) is reversed here.
    const pieces = runs.flatMap((run) => {
      const f = font(run.kind, bold);
      const words = run.level % 2 ? run.text.split(/( +)/).filter((w) => w.length).reverse().map((w) => {
        const mirrored = [...w].map((c) => bidi.getMirroredCharacter(c) ?? c);
        return ARABIC.test(w) ? mirrored.join("") : mirrored.reverse().join("");
      }) : [run.text];
      return words.map((text) => ({ text, f, w: doc.font(f).fontSize(size).widthOfString(text), space: /^ +$/.test(text) }));
    });
    const total = pieces.reduce((n, p) => n + p.w, 0);
    let cx = align === "right" ? x + width - total : x;
    for (const p of pieces) {
      // One baseline for both fonts: their ascents differ, so tops would not line up.
      if (!p.space) doc.font(p.f).fontSize(size).fillColor(color).text(p.text, cx, y + size * 1.1, { lineBreak: false, baseline: "alphabetic" });
      cx += p.w;
    }
  };

  let y = 0;
  const bottom = PAGE.h - PAGE.margin - PAGE.footer;
  const newPage = () => { doc.addPage(); y = PAGE.margin; };
  const room = (h: number) => { if (y + h > bottom) newPage(); };

  /**
   * A paragraph wrapped to a width (in logical order), each line laid out by the bidi algorithm; returns its height.
   * With `flow`, it is drawn from the current position line by line, moving to a new page whenever the next line does
   * not fit, so nothing runs over the footer however long it is (independent review of E16).
   */
  const para = (raw: string, x: number, at: number, width: number, opts: { size?: number; bold?: boolean; color?: string; align?: "left" | "right"; dry?: boolean; flow?: boolean } = {}) => {
    // One line of text: tabs and line breaks from data become spaces; an amount ("AED 12,000") never splits.
    const text = raw.replace(/[\t\r\n]+/g, " ").replace(/AED (\d)/g, "AED\u00A0$1");
    const size = opts.size ?? 9.5;
    const bold = opts.bold ?? false;
    const lh = size * (rtl || ARABIC.test(text) ? 1.75 : 1.45);
    const words = text.split(/( +)/).filter((w) => w.length);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur + w;
      if (cur.trim() && measure(next.trim(), size, bold) > width) {
        lines.push(cur.trim());
        cur = w.trim() ? w : "";
      } else cur = next;
    }
    if (cur.trim()) lines.push(cur.trim());
    // A left-to-right island cut by the wrap is closed at the end of its line and opened again on the next, so each
    // line's English keeps its own direction (and its full stop at its end).
    let open = false;
    for (let n = 0; n < lines.length; n++) {
      const l: string = (open ? "\u2066" : "") + lines[n]!;
      const opens: number = (l.match(/\u2066/g) ?? []).length - (l.match(/\u2069/g) ?? []).length;
      open = opens > 0;
      lines[n] = open ? `${l}\u2069` : l;
    }
    // A single word longer than the width (an address) is cut, never drawn off the page.
    const fitted = lines.flatMap((l) => {
      if (measure(l, size, bold) <= width) return [l];
      const parts: string[] = [];
      let p = "";
      for (const ch of l) { if (measure(p + ch, size, bold) > width && p) { parts.push(p); p = ch; } else p += ch; }
      if (p) parts.push(p);
      return parts;
    });
    if (opts.dry) return fitted.length * lh;
    const draw = (l: string, ly: number) => {
      drawLine(l, x, ly, width, size, bold, opts.color ?? C.ink, opts.align ?? (rtl ? "right" : "left"));
      drawn.push(l.replace(CONTROLS, "").replace(/\u00A0/g, " "));
    };
    if (opts.flow) {
      for (const l of fitted) { room(lh); draw(l, y); y += lh; }
      return fitted.length * lh;
    }
    fitted.forEach((l, n) => draw(l, at + n * lh));
    return fitted.length * lh;
  };

  // Header: the brand band, the title, the reference and date, the status banner.
  doc.rect(0, 0, PAGE.w, 104).fill(C.brand);
  const markX = rtl ? PAGE.w - PAGE.margin - 30 : PAGE.margin;
  doc.roundedRect(markX, 30, 30, 30, 7).fill(C.brandInk);
  doc.font("la-b").fontSize(18).fillColor(C.brand).text("T", markX, 34.5, { width: 30, align: "center", lineBreak: false });
  para(r.brand, rtl ? PAGE.margin : PAGE.margin + 42, 36, WIDTH - 42, { size: 12, bold: true, color: C.brandInk });
  para(r.title, PAGE.margin, 72, WIDTH, { size: 17, bold: true, color: C.brandInk });
  y = 120;
  y += para(rtl ? `المرجع \u2066${r.reference}\u2069 · التاريخ \u2066${r.date}\u2069` : `Reference ${r.reference} · Date ${r.date}`, PAGE.margin, y, WIDTH, { size: 9, color: C.muted }) + 8;
  const preliminary = r.status === "preliminary";
  const bannerH = para(r.statusLine, 0, 0, WIDTH - 24, { size: 10, bold: true, dry: true }) + 18;
  doc.roundedRect(PAGE.margin, y, WIDTH, bannerH, 6).fill(preliminary ? C.goldBg : C.okBg);
  doc.rect(rtl ? PAGE.margin + WIDTH - 4 : PAGE.margin, y, 4, bannerH).fill(preliminary ? C.gold : C.brand);
  para(r.statusLine, PAGE.margin + 12, y + 9, WIDTH - 24, { size: 10, bold: true, color: preliminary ? C.gold : C.brand });
  y += bannerH + 18;

  const table = (t: ReportTable) => {
    const n = t.columns.length;
    if (!n) return;
    // The place and the estimate get more room than the counts.
    const weights = t.columns.map((_, i) => (i === 0 ? 1.5 : i === 3 ? 1.6 : i === 5 ? 1.2 : i === 4 ? 0.7 : 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / sum) * WIDTH);
    const xs = widths.map((_, i) => PAGE.margin + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const order = rtl ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
    const colX = (i: number) => (rtl ? xs[n - 1 - order.indexOf(i)]! : xs[i]!);
    const row = (all: string[], header: boolean): void => {
      // A cell is a name, a status or an amount; a longer one is cut so a row always fits on a page.
      const cells = all.map((c) => (c.length > 160 ? `${c.slice(0, 157)}…` : c));
      const h = Math.max(...cells.map((c, i) => para(c, 0, 0, widths[i]! - 10, { size: 8.5, bold: header, dry: true }))) + 10;
      // A table that runs onto the next page repeats its header there.
      if (!header && y + h > bottom) { newPage(); row(t.columns, true); }
      room(h);
      if (header) doc.rect(PAGE.margin, y, WIDTH, h).fill(C.panel);
      cells.forEach((c, i) => para(c, colX(i) + 5, y + 5, widths[i]! - 10, { size: 8.5, bold: header, color: header ? C.muted : C.ink }));
      doc.moveTo(PAGE.margin, y + h).lineTo(PAGE.margin + WIDTH, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
      y += h;
    };
    row(t.columns, true);
    for (const cells of t.rows) row(cells, false);
    y += 10;
  };

  /** A line with a tag at its start ("[CHECKED] text") draws the tag as a coloured label. */
  const item = (l: string) => {
    const indent = /^\s+/.test(l) ? 14 : 0;
    const body = l.trim();
    if (!body) { y += 6; return; }
    const m = body.match(/^\[([^\]]+)\] ([\s\S]*)$/);
    const width = WIDTH - indent;
    if (!m) {
      para(body, rtl ? PAGE.margin : PAGE.margin + indent, 0, width, { size: indent ? 8.5 : 9.5, color: indent ? C.muted : C.ink, flow: true });
      y += 3;
      return;
    }
    const [, tag, text] = m;
    const [, fg, bg] = TAG_STYLE.find(([re]) => re.test(tag!.replace(CONTROLS, "")))!;
    const tagW = Math.min(150, measure(tag!, 7.5, true) + 10);
    room(16);
    const top = y;
    const tagX = rtl ? PAGE.margin + WIDTH - indent - tagW : PAGE.margin + indent;
    doc.roundedRect(tagX, y + 1, tagW, 12.5, 3).fill(bg);
    para(tag!, tagX + 5, y + 2.5, tagW - 10, { size: 7.5, bold: true, color: fg });
    para(text!, rtl ? PAGE.margin : tagX + tagW + 6, 0, width - tagW - 6, { size: 9, flow: true });
    if (y < top + 14) y = top + 14;
    y += 4;
  };

  for (const s of r.sections) {
    // A heading never sits alone at the foot of a page: it needs room for itself and a first line or table row.
    room(s.table ? 90 : 60);
    para(s.heading, PAGE.margin, y, WIDTH, { size: 12.5, bold: true, color: C.brand });
    y += 21;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + WIDTH, y).lineWidth(1).strokeColor(C.brand).stroke();
    y += 8;
    if (s.table) table(s.table);
    // With a table, the lines under it are the details per place.
    for (const l of s.lines) item(l);
    y += 12;
  }
  para(r.closing, PAGE.margin, 0, WIDTH, { size: 8.5, color: C.muted, flow: true });

  // The footer on every page: the brand, the reference, the label and the page.
  const pages = doc.bufferedPageRange();
  for (let p = 0; p < pages.count; p++) {
    doc.switchToPage(pages.start + p);
    const fy = PAGE.h - PAGE.margin + 4;
    doc.moveTo(PAGE.margin, fy - 8).lineTo(PAGE.margin + WIDTH, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke();
    const label = rtl
      ? `${r.brand} · \u2066${r.reference}\u2069 · ${preliminary ? "معلومات أوّلية، ليست مشورة" : "مشورة مراجَعة"} · صفحة ${p + 1} من ${pages.count}`
      : `${r.brand} · ${r.reference} · ${preliminary ? "Preliminary information, not advice" : "Reviewed advice"} · Page ${p + 1} of ${pages.count}`;
    para(label, PAGE.margin, fy, WIDTH, { size: 7.5, color: C.muted });
  }
  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve({ pdf: Buffer.concat(chunks), text: drawn }));
    doc.on("error", reject);
    doc.end();
  });
}
