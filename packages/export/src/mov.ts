import { ByteWriter } from "./bytes.ts";

/** QuickTime movie with a Photo-JPEG (Motion-JPEG) track. `jpegs` are complete JPEG files, one per frame. */
export function encodeMovMjpeg(jpegs: Uint8Array[], opts: { width: number; height: number; fps: number }): Uint8Array {
  if (!jpegs.length) throw new Error("MOV needs at least one frame");
  const { width, height, fps } = opts;
  const n = jpegs.length;
  // A timescale where one frame is a whole number of ticks.
  const [timescale, tick] = Number.isInteger(600 / fps) ? [600, 600 / fps] : [Math.round(fps * 1000), 1000];
  const duration = n * tick;
  const w = new ByteWriter();
  const box = (type: string, body: () => void) => {
    const at = w.length;
    w.u32(0).ascii(type);
    body();
    w.patchU32(at, w.length - at);
  };
  const full = (type: string, flags: number, body: () => void) => box(type, () => (w.u32(flags), body()));
  const matrix = () => w.u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000);
  const pascal = (s: string, fixed?: number) => {
    w.u8(s.length).ascii(s);
    if (fixed) w.zeros(fixed - 1 - s.length);
  };

  box("ftyp", () => w.ascii("qt  ").u32(0x200).ascii("qt  "));
  const offsets: number[] = [];
  box("mdat", () => {
    for (const j of jpegs) {
      offsets.push(w.length);
      w.bytes(j);
    }
  });
  box("moov", () => {
    full("mvhd", 0, () => {
      w.u32(0).u32(0).u32(timescale).u32(duration).u32(0x10000).u16(0x100).zeros(10);
      matrix();
      w.zeros(24).u32(2);
    });
    box("trak", () => {
      full("tkhd", 0x3, () => {
        w.u32(0).u32(0).u32(1).u32(0).u32(duration).zeros(8).u16(0).u16(0).u16(0).u16(0);
        matrix();
        w.u32(width << 16).u32(height << 16);
      });
      box("mdia", () => {
        full("mdhd", 0, () => w.u32(0).u32(0).u32(timescale).u32(duration).u16(0).u16(0));
        full("hdlr", 0, () => (w.ascii("mhlr").ascii("vide").u32(0).u32(0).u32(0), pascal("VideoHandler")));
        box("minf", () => {
          full("vmhd", 0x1, () => w.u16(0x40).u16(0x8000).u16(0x8000).u16(0x8000));
          full("hdlr", 0, () => (w.ascii("dhlr").ascii("alis").u32(0).u32(0).u32(0), pascal("DataHandler")));
          box("dinf", () => full("dref", 0, () => (w.u32(1), full("alis", 0x1, () => {}))));
          box("stbl", () => {
            full("stsd", 0, () => {
              w.u32(1);
              box("jpeg", () => {
                w.zeros(6).u16(1).u16(0).u16(0).ascii("appl").u32(0).u32(0x200);
                w.u16(width).u16(height).u32(72 << 16).u32(72 << 16).u32(0).u16(1);
                pascal("Photo - JPEG", 32);
                w.u16(24).i16(-1);
              });
            });
            full("stts", 0, () => w.u32(1).u32(n).u32(tick));
            full("stsc", 0, () => w.u32(1).u32(1).u32(1).u32(1));
            full("stsz", 0, () => {
              w.u32(0).u32(n);
              for (const j of jpegs) w.u32(j.length);
            });
            full("stco", 0, () => {
              w.u32(n);
              for (const o of offsets) w.u32(o);
            });
          });
        });
      });
    });
  });
  return w.result();
}
