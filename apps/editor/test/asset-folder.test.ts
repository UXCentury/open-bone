import { DocumentStore, createDocument } from "@openbone/core";
import { describe, expect, it, vi } from "vitest";

const images: Record<string, string> = {};
const sounds: Record<string, string> = {};
vi.mock("../src/state.ts", async () => {
  const { DocumentStore, createDocument } = await import("@openbone/core");
  return { store: new DocumentStore(createDocument("Untitled")), toast: () => {}, setFileName: () => {}, loadDocument: () => {}, fileName: () => "" };
});
vi.mock("../src/destructive.ts", () => ({ confirmDiscard: async () => true }));
vi.mock("../src/recent.ts", () => ({ addRecent: () => {}, removeRecent: () => {}, recentLabel: (p: string) => p }));
vi.mock("../src/images.ts", () => ({ registerImageOverride: (s: string, u: string) => (images[s] = u), imageAsDataUrl: async () => "", resolveImageUrl: () => "" }));
vi.mock("../src/audio.ts", () => ({ registerAudioOverride: (s: string, u: string) => (sounds[s] = u), audioAsDataUrl: async () => "", resolveAudioUrl: () => "" }));
vi.mock("../src/fonts.ts", () => ({ registerFontOverride: () => {}, fontAsDataUrl: async () => "", resolveFontUrl: () => "" }));

const { registerPickedAssets } = await import("../src/storage.ts");
const { store } = (await import("../src/state.ts")) as unknown as { store: DocumentStore };

/** A picked file as the folder input gives it: its path starts with the picked folder's name. */
const picked = (path: string) => Object.assign(new File(["x"], path.split("/").pop()!), { webkitRelativePath: path });

/**
 * A web page can't read the files next to a project it opened, so its art comes from a folder the user picks.
 * Files match by their path inside that folder.
 */
describe("project folder picked on the web", () => {
  it("shows the project's images and sounds from it, and lists what is missing", () => {
    const doc = createDocument("Neon Vault");
    doc.images.push({ id: "img_bg", name: "bg", src: "art/bg.jpg", width: 4, height: 4 } as never);
    doc.images.push({ id: "img_logo", name: "logo", src: "./art/logo.png", width: 4, height: 4 } as never);
    doc.images.push({ id: "img_gone", name: "gone", src: "art/gone.png", width: 4, height: 4 } as never);
    doc.images.push({ id: "img_inline", name: "inline", src: "data:image/png;base64,AA==", width: 1, height: 1 } as never);
    doc.audio = { master: 1, muted: false, assets: [{ id: "aud_m", name: "music", src: "audio/music.mp3", duration: 1 }], buses: [], sounds: [] } as never;
    store.load(doc);
    const missing = registerPickedAssets(store.doc, [picked("neon-vault/art/bg.jpg"), picked("neon-vault/art/logo.png"), picked("neon-vault/audio/music.mp3"), picked("neon-vault/neon-vault.obone")]);
    expect(Object.keys(images).sort()).toEqual(["./art/logo.png", "art/bg.jpg"]);
    expect(Object.keys(sounds)).toEqual(["audio/music.mp3"]);
    expect(missing).toEqual(["art/gone.png"]);
  });

  it("finds the files when a parent folder was picked", () => {
    const doc = createDocument("Parent");
    doc.images.push({ id: "img_k", name: "katana", src: "art/sym-katana.png", width: 4, height: 4 } as never);
    store.load(doc);
    expect(registerPickedAssets(store.doc, [picked("slots/neon-vault/art/sym-katana.png")])).toEqual([]);
    expect(images["art/sym-katana.png"]).toMatch(/^blob:/);
  });
});
