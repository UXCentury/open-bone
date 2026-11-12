/**
 * Family, weight and style of a font file, read from its `name` and `OS/2` tables (TrueType, OpenType, and the first
 * face of a collection). WOFF and WOFF2 compress their tables, so they return null: the caller falls back to the file
 * name.
 */
export interface FontMeta {
  family: string;
  /** Full name ("Noto Serif JP Bold"), when present. */
  fullName?: string;
  weight: number;
  style: "normal" | "italic";
}

export function readFontMeta(bytes: Uint8Array): FontMeta | null {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let base = 0;
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (tag === "ttcf") base = v.getUint32(12);
    else if (tag === "wOFF" || tag === "wOF2") return null;
    const numTables = v.getUint16(base + 4);
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + 16 * i;
      const t = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
      tables.set(t, { offset: v.getUint32(rec + 8), length: v.getUint32(rec + 12) });
    }
    const name = tables.get("name");
    if (!name) return null;
    const names = readNames(v, bytes, name.offset);
    const family = names.get(16) ?? names.get(1);
    if (!family) return null;
    let weight = 400;
    let italic = false;
    const os2 = tables.get("OS/2");
    if (os2 && os2.length >= 64) {
      weight = v.getUint16(os2.offset + 4) || 400;
      italic = (v.getUint16(os2.offset + 62) & 1) !== 0;
    } else {
      const head = tables.get("head");
      if (head) italic = (v.getUint16(head.offset + 44) & 2) !== 0;
    }
    return { family, ...(names.get(4) ? { fullName: names.get(4) } : {}), weight: Math.min(900, Math.max(100, weight)), style: italic ? "italic" : "normal" };
  } catch {
    return null;
  }
}

/** Name records by name id, preferring Windows English (UTF-16BE), then any Unicode, then Mac Roman. */
function readNames(v: DataView, bytes: Uint8Array, offset: number): Map<number, string> {
  const count = v.getUint16(offset + 2);
  const strings = offset + v.getUint16(offset + 4);
  const best = new Map<number, { rank: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const r = offset + 6 + 12 * i;
    const platform = v.getUint16(r);
    const language = v.getUint16(r + 4);
    const id = v.getUint16(r + 6);
    if (id !== 1 && id !== 4 && id !== 16) continue;
    const len = v.getUint16(r + 8);
    const at = strings + v.getUint16(r + 10);
    let text: string;
    let rank: number;
    if (platform === 3 || platform === 0) {
      let s = "";
      for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(at + k));
      text = s;
      rank = platform === 3 && language === 0x409 ? 0 : 1;
    } else if (platform === 1) {
      text = Array.from(bytes.subarray(at, at + len), (c) => String.fromCharCode(c)).join("");
      rank = language === 0 ? 2 : 3;
    } else continue;
    const prev = best.get(id);
    if (text && (!prev || rank < prev.rank)) best.set(id, { rank, text });
  }
  return new Map([...best].map(([k, x]) => [k, x.text]));
}

/** "NotoSerifJP-Bold.otf" → "NotoSerifJP-Bold": a fallback family when a file's tables can't be read. */
export function fontNameFromFile(file: string): string {
  return file.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}
