import { ByteWriter } from "./bytes.ts";
import { type PcmAudio, audioSpan, pcmBytes, pcmFrames } from "./pcm.ts";

/**
 * QuickTime movie with a Photo-JPEG (Motion-JPEG) track. `jpegs` are complete JPEG files, one per frame.
 * With `audio`, a 16-bit PCM sound track ("sowt") is added, interleaved with the video one chunk per frame.
 */
export function encodeMovMjpeg(jpegs: Uint8Array[], opts: { width: number; height: number; fps: number; audio?: PcmAudio | null }): Uint8Array {
  if (!jpegs.length) throw new Error("MOV needs at least one frame");
  const { width, height, fps } = opts;
  const audio = opts.audio && pcmFrames(opts.audio) > 0 ? opts.audio : null;
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
  const audioChunks: { offset: number; frames: number }[] = [];
  box("mdat", () => {
    jpegs.forEach((j, i) => {
      offsets.push(w.length);
      w.bytes(j);
      if (!audio) return;
      const [a, b] = audioSpan(audio, i, n, fps);
      if (b > a) {
        audioChunks.push({ offset: w.length, frames: b - a });
        w.bytes(pcmBytes(audio, a, b));
      }
    });
  });
  const dataInfo = () => {
    full("hdlr", 0, () => (w.ascii("dhlr").ascii("alis").u32(0).u32(0).u32(0), pascal("DataHandler")));
    box("dinf", () => full("dref", 0, () => (w.u32(1), full("alis", 0x1, () => {}))));
  };
  box("moov", () => {
    full("mvhd", 0, () => {
      w.u32(0).u32(0).u32(timescale).u32(duration).u32(0x10000).u16(0x100).zeros(10);
      matrix();
      w.zeros(24).u32(audio ? 3 : 2);
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
          dataInfo();
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
    if (audio) {
      const frames = pcmFrames(audio);
      const rate = audio.sampleRate;
      const movieDur = Math.round((frames / rate) * timescale);
      box("trak", () => {
        full("tkhd", 0x3, () => {
          w.u32(0).u32(0).u32(2).u32(0).u32(movieDur).zeros(8).u16(0).u16(1).u16(0x100).u16(0);
          matrix();
          w.u32(0).u32(0);
        });
        box("mdia", () => {
          full("mdhd", 0, () => w.u32(0).u32(0).u32(rate).u32(frames).u16(0).u16(0));
          full("hdlr", 0, () => (w.ascii("mhlr").ascii("soun").u32(0).u32(0).u32(0), pascal("SoundHandler")));
          box("minf", () => {
            full("smhd", 0, () => w.u16(0).u16(0));
            dataInfo();
            box("stbl", () => {
              full("stsd", 0, () => {
                w.u32(1);
                box("sowt", () => {
                  w.zeros(6).u16(1); // reserved, data reference index
                  w.u16(0).u16(0).u32(0); // version 0, revision, vendor
                  w.u16(audio.channels).u16(16).i16(0).u16(0).u32(rate * 0x10000);
                });
              });
              full("stts", 0, () => w.u32(1).u32(frames).u32(1));
              // One chunk per video frame; runs of equal-sized chunks share an entry.
              const runs: [number, number][] = [];
              audioChunks.forEach((c, i) => {
                if (!runs.length || runs[runs.length - 1][1] !== c.frames) runs.push([i + 1, c.frames]);
              });
              full("stsc", 0, () => {
                w.u32(runs.length);
                for (const [first, count] of runs) w.u32(first).u32(count).u32(1);
              });
              full("stsz", 0, () => w.u32(audio.channels * 2).u32(frames));
              full("stco", 0, () => {
                w.u32(audioChunks.length);
                for (const c of audioChunks) w.u32(c.offset);
              });
            });
          });
        });
      });
    }
  });
  return w.result();
}
