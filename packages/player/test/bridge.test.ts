import { describe, expect, it, vi } from "vitest";
import { BRIDGE_VERSION, type BridgePlayer, applyCommand, decodeMessage, encodeMessage, parseCommand, postToHost } from "../src/bridge.ts";

describe("bridge commands", () => {
  it("parses valid commands from strings and objects", () => {
    expect(parseCommand('{"type":"setInput","name":"speed","value":0.5}')).toEqual({ type: "setInput", name: "speed", value: 0.5 });
    expect(parseCommand({ type: "setInput", name: "on", value: true })).toEqual({ type: "setInput", name: "on", value: true });
    expect(parseCommand({ type: "fire", name: "jump" })).toEqual({ type: "fire", name: "jump" });
    expect(parseCommand({ type: "play" })).toEqual({ type: "play" });
    expect(parseCommand({ type: "play", animation: "walk", loop: false, extra: 1 })).toEqual({ type: "play", animation: "walk", loop: false });
    expect(parseCommand({ type: "setSkin", name: null })).toEqual({ type: "setSkin", name: null });
    expect(parseCommand({ type: "useStateMachine" })).toEqual({ type: "useStateMachine" });
    expect(parseCommand({ type: "getInputs" })).toEqual({ type: "getInputs" });
  });

  it("rejects malformed commands with readable errors", () => {
    expect(() => parseCommand("{}")).toThrow(/type/);
    expect(() => parseCommand({ type: "fly" })).toThrow(/unknown command "fly"/);
    expect(() => parseCommand({ type: "fire" })).toThrow(/needs a string `name`/);
    expect(() => parseCommand({ type: "setInput", name: "x", value: "1" })).toThrow(/boolean or number/);
    expect(() => parseCommand({ type: "setInput", name: "x", value: Number.NaN })).toThrow(/boolean or number/);
    expect(() => parseCommand("not json")).toThrow();
  });

  it("applies commands to a player", () => {
    const p: BridgePlayer = {
      setInput: vi.fn(),
      fire: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      playAnimation: vi.fn(),
      setSkin: vi.fn(),
      useStateMachine: vi.fn(),
      inputs: () => [{ name: "speed", type: "number", value: 0.25 }],
    };
    applyCommand(p, { type: "setInput", name: "speed", value: 1 });
    expect(p.setInput).toHaveBeenCalledWith("speed", 1);
    applyCommand(p, { type: "fire", name: "jump" });
    expect(p.fire).toHaveBeenCalledWith("jump");
    applyCommand(p, { type: "play", animation: "walk" });
    expect(p.playAnimation).toHaveBeenCalledWith("walk", true);
    expect(p.play).toHaveBeenCalled();
    applyCommand(p, { type: "pause" });
    expect(p.pause).toHaveBeenCalled();
    applyCommand(p, { type: "setSkin", name: "red" });
    expect(p.setSkin).toHaveBeenCalledWith("red");
    applyCommand(p, { type: "useStateMachine", name: "ui" });
    expect(p.useStateMachine).toHaveBeenCalledWith("ui");
    expect(applyCommand(p, { type: "getInputs" })).toEqual({ type: "inputs", inputs: [{ name: "speed", type: "number", value: 0.25 }] });
  });
});

describe("bridge messages", () => {
  it("wraps messages in a versioned envelope that round-trips", () => {
    const s = encodeMessage({ type: "stateChange", layer: "base", from: "idle", to: "walk" });
    expect(JSON.parse(s)).toEqual({ source: "openbone", v: BRIDGE_VERSION, type: "stateChange", layer: "base", from: "idle", to: "walk" });
    expect(decodeMessage(s)).toEqual(JSON.parse(s));
    expect(decodeMessage('{"type":"event"}')).toBeNull();
    expect(decodeMessage("nope")).toBeNull();
  });

  it("posts to every host channel that exists", () => {
    const flutter = { postMessage: vi.fn() };
    const ios = { postMessage: vi.fn() };
    const parent = { postMessage: vi.fn() };
    const s = postToHost({ type: "event", name: "step", int: 0, float: 0, string: "" }, { OpenBoneHost: flutter, webkit: { messageHandlers: { openbone: ios } }, parent });
    expect(flutter.postMessage).toHaveBeenCalledWith(s);
    expect(ios.postMessage).toHaveBeenCalledWith(s);
    expect(parent.postMessage).toHaveBeenCalledWith(JSON.parse(s), "*");
    expect(JSON.parse(s)).toMatchObject({ source: "openbone", type: "event", name: "step" });
  });

  it("does not post to itself when not embedded, and survives a broken channel", () => {
    const w: { parent?: unknown; OpenBoneHost: { postMessage(): void } } = {
      OpenBoneHost: {
        postMessage() {
          throw new Error("gone");
        },
      },
    };
    const self = { postMessage: vi.fn() };
    Object.assign(self, w);
    (self as { parent?: unknown }).parent = self;
    expect(() => postToHost({ type: "error", message: "x" }, self as never)).not.toThrow();
    expect(self.postMessage).not.toHaveBeenCalled();
  });
});
