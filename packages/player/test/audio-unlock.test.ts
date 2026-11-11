// WebAudioBackend before the first user gesture: no AudioContext is created (browsers refuse one and log
// "The AudioContext was not allowed to start"), sounds decode on an OfflineAudioContext, and loops requested early
// start once audio unlocks.
import type { OpenBoneDocument } from "@openbone/core";
import type { AudioCommand } from "@openbone/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebAudioBackend } from "../src/audio.ts";

const param = () => ({ value: 1, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });

let created = 0;
let started = 0;

class FakeAudioContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  private listeners: (() => void)[] = [];
  constructor() {
    created++;
  }
  addEventListener(type: string, fn: () => void) {
    if (type === "statechange") this.listeners.push(fn);
  }
  async resume() {
    this.state = "running";
    for (const fn of this.listeners) fn();
  }
  async close() {}
  createGain() {
    return { gain: param(), connect() {}, disconnect() {} };
  }
  createBufferSource() {
    return { buffer: null, loop: false, playbackRate: param(), connect() {}, start: () => started++, stop() {}, onended: null };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 1 });
  }
}

class FakeOfflineAudioContext {
  decodeAudioData() {
    return Promise.resolve({ duration: 1 });
  }
}

const doc = {
  audio: { master: 1, muted: false, buses: [], sounds: [], assets: [{ id: "a1", name: "music", src: "music.ogg" }] },
} as unknown as OpenBoneDocument;

const play = (id: string, loop: boolean): AudioCommand => ({ type: "play", id, sound: "s1", asset: "a1", bus: null, volume: 1, rate: 1, loop, fadeIn: 0, source: "test" });
const flush = () => new Promise((r) => setTimeout(r, 0));

const saved: Record<string, unknown> = {};
beforeEach(() => {
  created = 0;
  started = 0;
  for (const k of ["AudioContext", "OfflineAudioContext", "fetch"]) saved[k] = (globalThis as Record<string, unknown>)[k];
  Object.assign(globalThis, {
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
  });
});
afterEach(() => Object.assign(globalThis, saved));

describe("WebAudioBackend before a user gesture", () => {
  it("creates no AudioContext to decode or to queue a loop, and starts the loop once unlocked", async () => {
    const audio = new WebAudioBackend(doc);
    await audio.preload();
    audio.handle(play("v1", true));
    audio.handle(play("v2", false));
    await flush();
    expect(created).toBe(0);
    expect(started).toBe(0);

    audio.activate(); // a click
    await flush();
    expect(created).toBe(1);
    expect(started).toBe(1); // the loop; the one-shot was dropped
    expect(audio.activeVoices).toBe(1);
  });

  it("forgets a waiting loop that was stopped before audio unlocked", async () => {
    const audio = new WebAudioBackend(doc);
    audio.handle(play("v1", true));
    audio.handle({ type: "stop", id: "v1", fade: 0 });
    audio.activate();
    await flush();
    expect(started).toBe(0);
  });

  it("starts waiting loops when a shared context is resumed by its owner", async () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const audio = new WebAudioBackend(doc, { context: ctx });
    audio.handle(play("v1", true));
    await flush();
    expect(started).toBe(0);
    await ctx.resume();
    await flush();
    expect(started).toBe(1);
  });
});
