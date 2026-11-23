import { DocumentStore, createDocument, type OpenBoneDocument } from "@openbone/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only the link and the folder logic run here: the editor's UI modules (which need a page) are stubbed.
vi.mock("../src/state.ts", async () => {
  const { DocumentStore, createDocument } = await import("@openbone/core");
  return { store: new DocumentStore(createDocument("Untitled")), toast: () => {}, setFileName: () => {}, loadDocument: () => {}, fileName: () => "" };
});
vi.mock("../src/activity.ts", () => ({ logActivity: () => {} }));
vi.mock("../src/agent-fx.ts", () => ({ clearAgentFx: () => {} }));
vi.mock("../src/dialogs.tsx", () => ({ askConfirm: async () => true }));
vi.mock("../src/destructive.ts", () => ({ confirmDiscard: async () => true }));
vi.mock("../src/audio.ts", () => ({ registerAudioOverride: () => {}, audioAsDataUrl: async () => "", resolveAudioUrl: () => "" }));
vi.mock("../src/fonts.ts", () => ({ registerFontOverride: () => {}, fontAsDataUrl: async () => "", resolveFontUrl: () => "" }));
vi.mock("../src/images.ts", () => ({ registerImageOverride: () => {}, imageAsDataUrl: async () => "", resolveImageUrl: () => "" }));

/** Stands in for the browser WebSocket: records what the editor sends, lets the test play the server. */
class FakeSocket {
  static last: FakeSocket;
  static readonly OPEN = 1;
  readyState = 1;
  sent: { type: string }[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
  serve(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

const { connectBridge, disconnectBridge } = await import("../src/bridge.ts");
const { projectAssetDir, setProjectAssetDir } = await import("../src/storage.ts");
const { store } = (await import("../src/state.ts")) as unknown as { store: DocumentStore };

function king(): OpenBoneDocument {
  const d = createDocument("leopard-king");
  d.images.push({ id: "img_king", name: "king", src: "images/king.png", width: 10, height: 10 } as never);
  return d;
}

afterEach(() => disconnectBridge());

/**
 * A server that took this editor's scene has no file. Sending that scene back (a reconnect, or after the agent edited
 * it) must keep the folder the art is in, or the autosave forgets it and the art is gone after the next start.
 */
describe("MCP link keeps the project folder", () => {
  it("when the server sends this scene back unchanged", () => {
    store.load(king());
    setProjectAssetDir("/home/me/wahala/openbone");
    connectBridge("ws://test");
    FakeSocket.last.onopen?.();
    FakeSocket.last.serve({ type: "load", doc: store.doc });
    expect(projectAssetDir()).toBe("/home/me/wahala/openbone");
  });

  it("when the server sends the same project with the agent's edits", () => {
    store.load(king());
    setProjectAssetDir("/home/me/wahala/openbone");
    connectBridge("ws://test");
    FakeSocket.last.onopen?.();
    FakeSocket.last.serve({ type: "synced" });
    const edited = structuredClone(store.doc);
    edited.name = "leopard-king 2";
    FakeSocket.last.serve({ type: "load", doc: edited });
    expect(store.doc.name).toBe("leopard-king 2");
    expect(projectAssetDir()).toBe("/home/me/wahala/openbone");
  });

  it("but not for a different project", () => {
    store.load(king());
    setProjectAssetDir("/home/me/wahala/openbone");
    connectBridge("ws://test");
    FakeSocket.last.onopen?.();
    FakeSocket.last.serve({ type: "synced" });
    FakeSocket.last.serve({ type: "load", doc: createDocument("Other") });
    expect(projectAssetDir()).toBeNull();
  });
});

describe("MCP link and Open recent", () => {
  it("lists the server's project file in the desktop app", async () => {
    const { recentProjects } = await import("../src/recent.ts");
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    try {
      store.load(createDocument("Untitled"));
      connectBridge("ws://test");
      FakeSocket.last.onopen?.();
      FakeSocket.last.serve({ type: "load", doc: king(), path: "/home/me/wahala/openbone/king.obone" });
      expect(store.doc.name).toBe("leopard-king");
      expect(projectAssetDir()).toBe("/home/me/wahala/openbone");
      expect(recentProjects()[0]?.path).toBe("/home/me/wahala/openbone/king.obone");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
