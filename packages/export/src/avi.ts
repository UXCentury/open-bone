import { ByteWriter } from "./bytes.ts";
import { type PcmAudio, audioSpan, pcmBytes, pcmFrames } from "./pcm.ts";

/**
 * AVI with a Motion-JPEG video stream. `jpegs` are complete JPEG files, one per frame.
 * With `audio`, a 16-bit PCM stream is added, interleaved with the video one chunk per frame.
 */
export function encodeAviMjpeg(jpegs: Uint8Array[], opts: { width: number; height: number; fps: number; audio?: PcmAudio | null }): Uint8Array {
  if (!jpegs.length) throw new Error("AVI needs at least one frame");
  const { width, height, fps } = opts;
  const audio = opts.audio && pcmFrames(opts.audio) > 0 ? opts.audio : null;
  const n = jpegs.length;
  const maxFrame = Math.max(...jpegs.map((j) => j.length));
  const block = audio ? audio.channels * 2 : 0;
  const bytesPerSec = audio ? audio.sampleRate * block : 0;
  const maxAudio = audio ? Math.max(...jpegs.map((_, i) => (([a, b]) => (b - a) * block)(audioSpan(audio, i, n, fps)))) : 0;
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
  const index: { id: string; offset: number; size: number }[] = [];
  list("RIFF", "AVI ", () => {
    list("LIST", "hdrl", () => {
      chunk("avih", () => {
        w.u32(Math.round(1e6 / fps), true).u32(Math.ceil(maxFrame * fps) + bytesPerSec, true).u32(0, true).u32(audio ? 0x110 : 0x10, true);
        w.u32(n, true).u32(0, true).u32(audio ? 2 : 1, true).u32(maxFrame + maxAudio + 16, true).u32(width, true).u32(height, true).zeros(16);
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
      if (audio)
        list("LIST", "strl", () => {
          chunk("strh", () => {
            w.ascii("auds").u32(0, true).u32(0, true).u16(0, true).u16(0, true).u32(0, true);
            // scale/rate: one "sample" is one block (a frame of all channels).
            w.u32(block, true).u32(bytesPerSec, true).u32(0, true).u32(pcmFrames(audio), true).u32(maxAudio, true).u32(0xffffffff, true).u32(block, true);
            w.i16(0, true).i16(0, true).i16(0, true).i16(0, true);
          });
          chunk("strf", () => {
            // WAVEFORMATEX, PCM
            w.u16(1, true).u16(audio.channels, true).u32(audio.sampleRate, true).u32(bytesPerSec, true).u16(block, true).u16(16, true).u16(0, true);
          });
        });
    });
    list("LIST", "movi", () => {
      const moviType = w.length - 4; // offsets in idx1 are relative to the "movi" fourcc
      jpegs.forEach((j, i) => {
        index.push({ id: "00dc", offset: w.length - moviType, size: j.length });
        chunk("00dc", () => w.bytes(j));
        if (!audio) return;
        const [a, b] = audioSpan(audio, i, n, fps);
        if (b <= a) return;
        const pcm = pcmBytes(audio, a, b);
        index.push({ id: "01wb", offset: w.length - moviType, size: pcm.length });
        chunk("01wb", () => w.bytes(pcm));
      });
    });
    chunk("idx1", () => {
      for (const e of index) w.ascii(e.id).u32(0x10, true).u32(e.offset, true).u32(e.size, true);
    });
  });
  return w.result();
}
