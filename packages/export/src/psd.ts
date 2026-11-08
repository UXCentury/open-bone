import { ByteWriter, type Frame } from "./bytes.ts";

/**
 * Layered Photoshop document (8-bit RGB with transparency, uncompressed). One layer per frame, named;
 * the first layer is visible and the rest hidden, and the flattened image is the first frame.
 */
export function encodePsd(layers: { name: string; frame: Frame }[]): Uint8Array {
  if (!layers.length) throw new Error("PSD needs at least one layer");
  const { width, height } = layers[0].frame;
  const plane = width * height;
  const w = new ByteWriter();
  // Header
  w.ascii("8BPS").u16(1).zeros(6).u16(4).u32(height).u32(width).u16(8).u16(3);
  w.u32(0); // colour mode data
  w.u32(0); // image resources

  const layerInfo = new ByteWriter();
  // Negative count: the merged image's extra channel is its transparency.
  layerInfo.i16(-layers.length);
  // Records are bottom-to-top; write in reverse so the first frame is the top layer.
  const ordered = [...layers].reverse();
  const enc = new TextEncoder();
  for (const [i, l] of ordered.entries()) {
    if (l.frame.width !== width || l.frame.height !== height) throw new Error("All PSD layers must be the same size");
    layerInfo.i32(0).i32(0).i32(height).i32(width).u16(4);
    for (const id of [-1, 0, 1, 2]) layerInfo.i16(id).u32(2 + plane);
    const top = i === ordered.length - 1;
    layerInfo.ascii("8BIM").ascii("norm").u8(255).u8(0).u8(top ? 0 : 0x02).u8(0);
    const name = enc.encode(l.name).subarray(0, 255);
    const nameLen = 1 + name.length;
    const padded = Math.ceil(nameLen / 4) * 4;
    layerInfo.u32(4 + 4 + padded); // extra data: mask + blending ranges + name
    layerInfo.u32(0).u32(0).u8(name.length).bytes(name).zeros(padded - nameLen);
  }
  const channel = (f: Frame, c: number) => {
    const out = new Uint8Array(plane);
    for (let p = 0; p < plane; p++) out[p] = f.data[p * 4 + c];
    return out;
  };
  for (const l of ordered) for (const c of [3, 0, 1, 2]) layerInfo.u16(0).bytes(channel(l.frame, c));
  if (layerInfo.length % 2) layerInfo.u8(0);
  const li = layerInfo.result();
  w.u32(4 + li.length + 4); // layer and mask info section
  w.u32(li.length).bytes(li);
  w.u32(0); // global layer mask
  // Flattened image: planar R, G, B, A of the first frame.
  w.u16(0);
  const first = layers[0].frame;
  for (const c of [0, 1, 2, 3]) w.bytes(channel(first, c));
  return w.result();
}
