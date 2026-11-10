import { type OpenBoneDocument, serialize, serializeBinary } from "@openbone/core";

/** One scale of an atlas export: the runtime document (its atlas pages as data: URIs) and its file name suffix. */
export interface AtlasVariantDoc {
  suffix: string;
  doc: OpenBoneDocument;
}

export interface AtlasFilesOptions {
  /** Runtime data as .obonb instead of .json. Default false. */
  binary?: boolean;
  /** Indented JSON. Default true. */
  pretty?: boolean;
  precision?: "float32" | "float64";
}

function dataUriBytes(src: string): { bytes: Uint8Array; ext: string } {
  const m = /^data:([^;,]+)?(;base64)?,/.exec(src);
  if (!m) throw new Error("Atlas page is not a data: URI");
  const body = src.slice(m[0].length);
  const ext = m[1] === "image/jpeg" ? "jpg" : m[1] === "image/webp" ? "webp" : "png";
  if (!m[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(body)), ext };
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, ext };
}

/**
 * The files of an atlas export: per scale variant, the runtime data `<base><suffix>.json` (or .obonb) next to its
 * pages `<base><suffix>.png`, `<base><suffix>_2.png` … (or .jpg), which the data refers to by file name. The
 * documents are not changed.
 */
export function atlasExportFiles(base: string, variants: AtlasVariantDoc[], o: AtlasFilesOptions = {}): { name: string; data: Uint8Array }[] {
  const files: { name: string; data: Uint8Array }[] = [];
  const names = new Set<string>();
  for (const v of variants) {
    const d = structuredClone(v.doc);
    const stem = `${base}${v.suffix}`;
    for (const [i, p] of (d.atlas?.pages ?? []).entries()) {
      const { bytes, ext } = dataUriBytes(p.src);
      const name = `${stem}${i ? `_${i + 1}` : ""}.${ext}`;
      if (names.has(name)) throw new Error(`Two files would be named ${name}: give each scale its own suffix`);
      names.add(name);
      files.push({ name, data: bytes });
      p.src = name;
    }
    const name = `${stem}.${o.binary ? "obonb" : "json"}`;
    if (names.has(name)) throw new Error(`Two files would be named ${name}: give each scale its own suffix`);
    names.add(name);
    const data = o.binary ? serializeBinary(d, { precision: o.precision ?? "float32" }) : new TextEncoder().encode(o.pretty === false ? JSON.stringify(d) : serialize(d));
    files.push({ name, data });
  }
  // Data files first (what people open), pages after.
  return [...files.filter((f) => /\.(json|obonb)$/.test(f.name)), ...files.filter((f) => !/\.(json|obonb)$/.test(f.name))];
}
