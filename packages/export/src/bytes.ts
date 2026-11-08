/** Growable little/big-endian byte writer shared by the encoders. */
export class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }
  u16(v: number, le = false) {
    this.ensure(2);
    this.view.setUint16(this.length, v, le);
    this.length += 2;
    return this;
  }
  i16(v: number, le = false) {
    this.ensure(2);
    this.view.setInt16(this.length, v, le);
    this.length += 2;
    return this;
  }
  u32(v: number, le = false) {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, le);
    this.length += 4;
    return this;
  }
  i32(v: number, le = false) {
    this.ensure(4);
    this.view.setInt32(this.length, v, le);
    this.length += 4;
    return this;
  }
  bytes(b: ArrayLike<number>) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  zeros(n: number) {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }
  /** Overwrite a u32 written earlier (for sizes known only afterwards). */
  patchU32(at: number, v: number, le = false) {
    this.view.setUint32(at, v >>> 0, le);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE), as used by PNG and ZIP. */
export function crc32(data: ArrayLike<number>, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** zlib-wrapped deflate using the platform's CompressionStream (browsers and Node 18+). */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An RGBA frame (8 bits per channel, non-premultiplied, row-major). */
export interface Frame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
