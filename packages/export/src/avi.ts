import { ByteWriter } from "./bytes.ts";

/** AVI with a Motion-JPEG video stream. `jpegs` are complete JPEG files, one per frame. */
export function encodeAviMjpeg(jpegs: Uint8Array[], opts: { width: number; height: number; fps: number }): Uint8Array {
  if (!jpegs.length) throw new Error("AVI needs at least one frame");
  const { width, height, fps } = opts;
  const n = jpegs.length;
  const maxFrame = Math.max(...jpegs.map((j) => j.length));
  const w = new ByteWriter();
  const list = (fourcc: string, type: string, body: () => void) => {
    w.ascii(fourcc);
    const at = w.length;
    w.u32(0, true).ascii(type);
    body();
    w.patchU32(at, w.length - at - 4, true);
  };
  const chunk = (id: string, body: () => void) => {
    w.ascii(id);
    const at = w.length;
    w.u32(0, true);
    body();
    const size = w.length - at - 4;
    w.patchU32(at, size, true);
    if (size % 2) w.u8(0);
  };
  const scale = 1000;
  const rate = Math.round(fps * scale);
  const index: { offset: number; size: number }[] = [];
  list("RIFF", "AVI ", () => {
    list("LIST", "hdrl", () => {
      chunk("avih", () => {
        w.u32(Math.round(1e6 / fps), true).u32(Math.ceil(maxFrame * fps), true).u32(0, true).u32(0x10, true);
        w.u32(n, true).u32(0, true).u32(1, true).u32(maxFrame, true).u32(width, true).u32(height, true).zeros(16);
      });
      list("LIST", "strl", () => {
        chunk("strh", () => {
          w.ascii("vids").ascii("MJPG").u32(0, true).u16(0, true).u16(0, true).u32(0, true);
          w.u32(scale, true).u32(rate, true).u32(0, true).u32(n, true).u32(maxFrame, true).u32(0xffffffff, true).u32(0, true);
          w.i16(0, true).i16(0, true).i16(width, true).i16(height, true);
        });
        chunk("strf", () => {
          w.u32(40, true).i32(width, true).i32(height, true).u16(1, true).u16(24, true).ascii("MJPG");
          w.u32(width * height * 3, true).i32(0, true).i32(0, true).u32(0, true).u32(0, true);
        });
      });
    });
    list("LIST", "movi", () => {
      const moviType = w.length - 4; // offsets in idx1 are relative to the "movi" fourcc
      for (const j of jpegs) {
        index.push({ offset: w.length - moviType, size: j.length });
        chunk("00dc", () => w.bytes(j));
      }
    });
    chunk("idx1", () => {
      for (const e of index) w.ascii("00dc").u32(0x10, true).u32(e.offset, true).u32(e.size, true);
    });
  });
  return w.result();
}
