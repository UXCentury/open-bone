import { createDocument } from "@openbone/core";
import { describe, expect, it } from "vitest";
import { type DecodedAudio, type TimedMixCommand, decodeWav, encodeWav, mixAudioCommands } from "../src/index.ts";

/** Video sound tracks: the runtime's timed audio commands mixed like the players play them. */

const SR = 1000; // small rate: exact sample positions are easy to reason about
const ones = (n: number): DecodedAudio => ({ sampleRate: SR, channels: [new Float32Array(n).fill(1)] });

function doc() {
  const d = createDocument("mix");
  d.audio = {
    master: 0.5,
    muted: false,
    assets: [],
    buses: [
      { id: "sfx", name: "sfx", volume: 0.8, muted: false },
      { id: "off", name: "off", volume: 1, muted: true },
    ],
    sounds: [],
  };
  return d;
}

const play = (time: number, id: string, o: Partial<{ asset: string; bus: string | null; volume: number; rate: number; loop: boolean; fadeIn: number }> = {}): TimedMixCommand => ({
  time,
  command: { type: "play", id, asset: o.asset ?? "a", bus: o.bus === undefined ? "sfx" : o.bus, volume: o.volume ?? 1, rate: o.rate ?? 1, loop: o.loop ?? false, fadeIn: o.fadeIn ?? 0 },
});

describe("mixAudioCommands", () => {
  it("places sounds at their time with volume x bus x master, and ends one-shots", () => {
    const m = mixAudioCommands(doc(), [play(0.1, "p1", { volume: 0.5 })], 0.5, () => ones(200), { sampleRate: SR })!;
    const [l, r] = m.channels;
    expect(l.length).toBe(500);
    expect(l[99]).toBe(0);
    expect(l[100]).toBeCloseTo(0.5 * 0.8 * 0.5); // volume x bus x master
    expect(r[150]).toBeCloseTo(0.2); // mono goes to both sides
    expect(l[299]).toBeCloseTo(0.2);
    expect(l[300]).toBe(0); // 200 samples long
  });

  it("loops, resamples, fades in, fades and stops with a fade", () => {
    const cmds: TimedMixCommand[] = [
      play(0, "loop", { loop: true, bus: null, fadeIn: 0.1 }),
      { time: 0.2, command: { type: "fade", id: "loop", volume: 0.5, duration: 0.1 } },
      { time: 0.4, command: { type: "stop", id: "loop", fade: 0.1 } },
    ];
    const l = mixAudioCommands(doc(), cmds, 0.6, () => ones(30), { sampleRate: SR })!.channels[0];
    expect(l[0]).toBe(0);
    expect(l[50]).toBeCloseTo(0.25, 2); // halfway through the fade-in (x master 0.5)
    expect(l[150]).toBeCloseTo(0.5); // looping past the 30-sample source
    expect(l[250]).toBeCloseTo(0.375, 2); // halfway through the fade to 0.5
    expect(l[350]).toBeCloseTo(0.25);
    expect(l[450]).toBeCloseTo(0.125, 2); // fading out
    expect(l[520]).toBe(0);
    // Rate 2 plays a 100-sample source in 50 output samples.
    const fast = mixAudioCommands(doc(), [play(0, "f", { rate: 2, bus: null })], 0.2, () => ones(100), { sampleRate: SR })!.channels[0];
    expect(fast[49]).toBeCloseTo(0.5);
    expect(fast[51]).toBe(0);
  });

  it("follows mute commands and the document's mutes", () => {
    const cmds: TimedMixCommand[] = [
      play(0, "a", { loop: true }),
      play(0, "b", { loop: true, bus: "off" }), // the document mutes this bus
      { time: 0.1, command: { type: "mix", bus: "sfx", muted: true } },
      { time: 0.2, command: { type: "mix", bus: "sfx", muted: false } },
      { time: 0.2, command: { type: "mix", bus: "off", muted: false } },
      { time: 0.3, command: { type: "mix", bus: null, muted: true } },
    ];
    const l = mixAudioCommands(doc(), cmds, 0.4, () => ones(10), { sampleRate: SR })!.channels[0];
    expect(l[50]).toBeCloseTo(0.4); // a only (0.8 x 0.5); b muted by the document
    expect(l[150]).toBe(0); // sfx muted
    expect(l[250]).toBeCloseTo(0.4 + 0.5); // both: b's bus unmuted (1 x 0.5)
    expect(l[350]).toBe(0); // everything muted
  });

  it("leaves out what can't be decoded, and returns null when nothing plays", () => {
    const missing = new Set<string>();
    expect(mixAudioCommands(doc(), [play(0, "x", { asset: "mp3" })], 1, () => null, { missing })).toBeNull();
    expect([...missing]).toEqual(["mp3"]);
    expect(mixAudioCommands(doc(), [], 1, () => ones(1))).toBeNull();
  });
});

describe("WAV", () => {
  it("round-trips through encodeWav / decodeWav", () => {
    const l = new Float32Array([0, 0.5, -0.5, 1]);
    const r = new Float32Array([1, -1, 0.25, 0]);
    const back = decodeWav(encodeWav({ sampleRate: 22050, channels: [l, r] }))!;
    expect(back.sampleRate).toBe(22050);
    expect(back.channels).toHaveLength(2);
    for (let i = 0; i < 4; i++) {
      expect(back.channels[0][i]).toBeCloseTo(l[i], 3);
      expect(back.channels[1][i]).toBeCloseTo(r[i], 3);
    }
    expect(decodeWav(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
