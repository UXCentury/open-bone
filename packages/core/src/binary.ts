import { deserialize } from "./document.ts";
import type { OpenBoneDocument } from "./types.ts";

/**
 * Binary OpenBone document (.obonb): the same data as .obone JSON in a compact tagged encoding.
 *
 * Layout: magic "OBNB", u8 format version, varint string count, the strings (varint byte length + UTF-8),
 * then one value. Values start with a tag byte:
 *   0 null · 1 false · 2 true · 3 uint (varint) · 4 negative int (varint of -n-1) · 5 float32 · 6 float64
 *   7 string (varint index into the string table) · 8 array (varint length, values)
 *   9 object (varint count, then key index + value pairs) · 10 data: URL (mime index, varint length, raw bytes)
 * Object keys and repeated strings (ids, names) are stored once. Non-integer numbers are float32 by default
 * (as in Spine binary); on load they are rounded to 7 significant digits, so values like 0.42 come back exactly.
 */

const MAGIC = [0x4f, 0x42, 0x4e, 0x42]; // "OBNB"
const BINARY_VERSION = 1;
const T = { null: 0, false: 1, true: 2, uint: 3, nint: 4, f32: 5, f64: 6, str: 7, arr: 8, obj: 9, data: 10 } as const;

export interface BinaryOptions {
  /** "float32" (default, smaller) or "float64" (lossless). */
  precision?: "float32" | "float64";
}

export function isBinaryDocument(bytes: ArrayLike<number>): boolean {
  return bytes.length >= 5 && MAGIC.every((b, i) => bytes[i] === b);
}

class Writer {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  varint(n: number) {
    // Unsigned LEB128, safe up to 2^53.
    this.ensure(8);
    while (n >= 0x80) {
      this.buf[this.len++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.len++] = n;
  }
  f32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64(v: number) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
  }
  result() {
    return this.buf.slice(0, this.len);
  }
}

const DATA_URL = /^data:([^;,]+);base64,/;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Encode a document as .obonb bytes. */
export function serializeBinary(doc: OpenBoneDocument, opts: BinaryOptions = {}): Uint8Array {
  const f32 = (opts.precision ?? "float32") === "float32";
  const strings: string[] = [];
  const index = new Map<string, number>();
  const intern = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const body = new Writer();
  const value = (v: unknown): void => {
    if (v === null || v === undefined) return body.byte(T.null);
    if (v === false) return body.byte(T.false);
    if (v === true) return body.byte(T.true);
    if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
        if (v >= 0) {
          body.byte(T.uint);
          body.varint(v);
        } else {
          body.byte(T.nint);
          body.varint(-v - 1);
        }
      } else if (f32 && Number.isFinite(v)) {
        body.byte(T.f32);
        body.f32(v);
      } else {
        body.byte(T.f64);
        body.f64(v);
      }
      return;
    }
    if (typeof v === "string") {
      const m = DATA_URL.exec(v);
      if (m) {
        const bytes = b64ToBytes(v.slice(m[0].length));
        body.byte(T.data);
        body.varint(intern(m[1]));
        body.varint(bytes.length);
        body.bytes(bytes);
        return;
      }
      body.byte(T.str);
      body.varint(intern(v));
      return;
    }
    if (Array.isArray(v)) {
      body.byte(T.arr);
      body.varint(v.length);
      for (const x of v) value(x);
      return;
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      body.byte(T.obj);
      body.varint(entries.length);
      for (const [k, x] of entries) {
        body.varint(intern(k));
        value(x);
      }
      return;
    }
    throw new Error(`Cannot encode ${typeof v} in a binary document`);
  };
  value(doc);
  const out = new Writer();
  for (const b of MAGIC) out.byte(b);
  out.byte(BINARY_VERSION);
  out.varint(strings.length);
  const enc = new TextEncoder();
  for (const s of strings) {
    const b = enc.encode(s);
    out.varint(b.length);
    out.bytes(b);
  }
  out.bytes(body.result());
  return out.result();
}

/** Decode .obonb bytes (validated like a JSON document). */
export function deserializeBinary(bytes: Uint8Array): OpenBoneDocument {
  if (!isBinaryDocument(bytes)) throw new Error("Not an OpenBone binary document (missing OBNB header)");
  const version = bytes[4];
  if (version > BINARY_VERSION) throw new Error(`Binary version ${version} is newer than supported ${BINARY_VERSION}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 5;
  const fail = () => {
    throw new Error("Corrupt OpenBone binary document");
  };
  const varint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      if (p >= bytes.length) fail();
      const b = bytes[p++];
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 0x80;
      if (mul > 2 ** 56) fail();
    }
  };
  const dec = new TextDecoder();
  const count = varint();
  const strings: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const n = varint();
    if (p + n > bytes.length) fail();
    strings[i] = dec.decode(bytes.subarray(p, p + n));
    p += n;
  }
  const str = () => {
    const i = varint();
    if (i >= strings.length) fail();
    return strings[i];
  };
  const value = (): unknown => {
    if (p >= bytes.length) fail();
    const tag = bytes[p++];
    switch (tag) {
      case T.null:
        return null;
      case T.false:
        return false;
      case T.true:
        return true;
      case T.uint:
        return varint();
      case T.nint:
        return -varint() - 1;
      case T.f32: {
        if (p + 4 > bytes.length) fail();
        const v = view.getFloat32(p, true);
        p += 4;
        return Number(v.toPrecision(7));
      }
      case T.f64: {
        if (p + 8 > bytes.length) fail();
        const v = view.getFloat64(p, true);
        p += 8;
        return v;
      }
      case T.str:
        return str();
      case T.arr: {
        const n = varint();
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = value();
        return a;
      }
      case T.obj: {
        const n = varint();
        const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const k = str();
          o[k] = value();
        }
        return o;
      }
      case T.data: {
        const mime = str();
        const n = varint();
        if (p + n > bytes.length) fail();
        const url = `data:${mime};base64,${bytesToB64(bytes.subarray(p, p + n))}`;
        p += n;
        return url;
      }
      default:
        return fail();
    }
  };
  const doc = value();
  // Reuse the JSON loader's checks and defaults.
  return deserialize(JSON.stringify(doc));
}

/** Load a document from file bytes, whichever format they are in (.obonb binary or .obone JSON). */
export function parseDocument(bytes: Uint8Array): OpenBoneDocument {
  return isBinaryDocument(bytes) ? deserializeBinary(bytes) : deserialize(new TextDecoder().decode(bytes));
}
