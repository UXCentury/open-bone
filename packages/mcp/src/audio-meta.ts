/**
 * Duration (seconds) of an audio file from its bytes, without decoding it: WAV (RIFF data chunk), MP3 (Xing/Info or
 * VBRI header, else every frame counted), OGG Vorbis / Opus (last page's granule position) and FLAC (STREAMINFO).
 * 0 when the format is not recognised.
 */
export function audioDuration(buf: Uint8Array): number {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const round = (s: number) => (Number.isFinite(s) && s > 0 ? Math.round(s * 1000) / 1000 : 0);
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return round(wav(b));
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "OggS") return round(ogg(b));
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "fLaC") return round(flac(b));
  return round(mp3(b));
}

function wav(b: Buffer): number {
  let byteRate = 0;
  for (let p = 12; p + 8 <= b.length; ) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt " && p + 16 <= b.length) byteRate = b.readUInt32LE(p + 16);
    if (id === "data") return byteRate ? Math.min(size, b.length - p - 8) / byteRate : 0;
    p += 8 + size + (size % 2);
  }
  return 0;
}

// MPEG audio: bitrates (kbps) by [version (1 / 2 and 2.5)][layer 1..3][index], sample rates by version.
const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame {
  size: number;
  samples: number;
  rate: number;
  version: number;
  channels: number;
}

function frameAt(b: Buffer, p: number): Frame | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const v = (b[p + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (b[p + 1] >> 1) & 3; // 3 = layer I, 2 = II, 1 = III
  const bi = (b[p + 2] >> 4) & 15;
  const ri = (b[p + 2] >> 2) & 3;
  if (v === 1 || layerBits === 0 || bi === 0 || bi === 15 || ri === 3) return null;
  const layer = 4 - layerBits;
  const kbps = BITRATES[`${v === 3 ? 1 : 2}-${layer}`][bi];
  const rate = RATES[v][ri];
  const pad = (b[p + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 3 && v !== 3 ? 576 : 1152;
  const size = layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
  const channels = ((b[p + 3] >> 6) & 3) === 3 ? 1 : 2;
  return size > 4 ? { size, samples, rate, version: v, channels } : null;
}

function mp3(b: Buffer): number {
  let p = 0;
  // ID3v2 tag(s) at the start.
  while (p + 10 <= b.length && b.toString("ascii", p, p + 3) === "ID3") {
    const size = ((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f);
    p += 10 + size + (b[p + 5] & 0x10 ? 10 : 0);
  }
  // First frame: a header followed by another valid header (avoids false syncs in junk).
  let first: Frame | null = null;
  for (; p + 4 <= b.length; p++) {
    const f = frameAt(b, p);
    if (f && (p + f.size >= b.length || frameAt(b, p + f.size))) {
      first = f;
      break;
    }
  }
  if (!first) return 0;
  // Xing / Info (VBR or LAME CBR) header: total frame count.
  const side = first.version === 3 ? (first.channels === 1 ? 17 : 32) : first.channels === 1 ? 9 : 17;
  const x = p + 4 + side;
  const tag = b.toString("ascii", x, x + 4);
  if ((tag === "Xing" || tag === "Info") && b.readUInt32BE(x + 4) & 1) {
    const frames = b.readUInt32BE(x + 8);
    // The LAME tag (when present) gives the encoder delay and padding to leave out.
    let gapless = 0;
    if (b.toString("ascii", x + 120, x + 124) === "LAME" || b.toString("ascii", x + 120, x + 124) === "Lavc") {
      const d = b.readUIntBE(x + 141, 3);
      gapless = (d >> 12) + (d & 0xfff);
    }
    return (frames * first.samples - gapless) / first.rate;
  }
  // VBRI (Fraunhofer) header, 32 bytes after the frame header.
  if (b.toString("ascii", p + 36, p + 40) === "VBRI") return (b.readUInt32BE(p + 36 + 14) * first.samples) / first.rate;
  // Otherwise count the frames.
  let samples = 0;
  while (p + 4 <= b.length) {
    const f = frameAt(b, p);
    if (!f) {
      if (b.toString("ascii", p, p + 3) === "TAG") break; // ID3v1 at the end
      p++;
      continue;
    }
    samples += f.samples;
    p += f.size;
  }
  return samples / first.rate;
}

function ogg(b: Buffer): number {
  // Codec from the first packet of the first page.
  const segs = b[26];
  const body = 27 + segs;
  let rate = 0;
  let preSkip = 0;
  if (b[body] === 1 && b.toString("ascii", body + 1, body + 7) === "vorbis") rate = b.readUInt32LE(body + 12);
  else if (b.toString("ascii", body, body + 8) === "OpusHead") {
    rate = 48000; // Opus granule positions always count 48 kHz samples
    preSkip = b.readUInt16LE(body + 10);
  }
  if (!rate) return 0;
  // Granule position of the last page.
  for (let p = b.length - 27; p >= 0; p--) {
    if (b[p] === 0x4f && b.toString("ascii", p, p + 4) === "OggS") {
      const granule = Number(b.readBigUInt64LE(p + 6));
      return (granule - preSkip) / rate;
    }
  }
  return 0;
}

function flac(b: Buffer): number {
  // STREAMINFO is the first metadata block: 20-bit sample rate, 36-bit total samples.
  const p = 8;
  if (b.length < p + 18) return 0;
  const rate = (b[p + 10] << 12) | (b[p + 11] << 4) | (b[p + 12] >> 4);
  const total = (b[p + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(p + 14);
  return rate ? total / rate : 0;
}
