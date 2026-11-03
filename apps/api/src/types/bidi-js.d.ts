// bidi-js 1.1.0 ships no types: the part of its API the report renderer uses (E16, D98).
declare module "bidi-js" {
  interface Bidi {
    getEmbeddingLevels(text: string, direction?: "ltr" | "rtl" | "auto"): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> };
    getReorderSegments(text: string, levels: { levels: Uint8Array }, start?: number, end?: number): Array<[number, number]>;
    getMirroredCharacter(ch: string): string | null;
  }
  export default function bidiFactory(): Bidi;
}
