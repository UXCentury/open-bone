import { type SavedHistory, deserialize, encodeHistory, restoreHistory, serialize } from "@openbone/core";
import { get, set } from "idb-keyval";
import { createEffect, createRoot, on } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { fileName, loadDocument, modified, openExample, setModified, store } from "./state.ts";
import { projectAssetDir, projectFilePath, restoreDesktopAssets } from "./storage.ts";
import "./styles.css";

// Restore the last session (autosaved to IndexedDB, with its undo/redo history), else open the walker example.
(async () => {
  try {
    const saved = (await get("openbone.autosave")) as
      | { json: string; name: string; history?: SavedHistory; modified?: boolean; dir?: string | null; path?: string | null }
      | undefined;
    if (saved) {
      const doc = deserialize(saved.json);
      // Desktop: art stored next to the project file is read again from that folder.
      const restored = await restoreDesktopAssets(doc, saved);
      loadDocument(doc, saved.name, "/examples/");
      restored();
      // Ctrl+Z keeps working after a reload: the history is stored as patches against the saved document.
      restoreHistory(store, saved.history);
      setModified(saved.modified ?? false);
    } else await openExample(new URLSearchParams(location.search).get("example") ?? "walker");
  } catch {
    await openExample("walker");
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(t);
    t = undefined;
    let history: SavedHistory | undefined;
    try {
      history = encodeHistory(store);
    } catch (e) {
      console.warn("[openbone] could not save the undo history", e);
    }
    set("openbone.autosave", { json: serialize(store.doc, false), name: fileName(), history, modified: modified(), dir: projectAssetDir(), path: projectFilePath() }).catch(() => {});
  };
  store.subscribe(() => {
    clearTimeout(t);
    t = setTimeout(save, 500);
  });
  // Saving clears "modified" without changing the document: store that too, so a reload doesn't ask again.
  createRoot(() => createEffect(on(modified, () => (t === undefined ? (t = setTimeout(save, 500)) : undefined), { defer: true })));
  // A refresh right after an edit: write now instead of losing the last change.
  const flush = () => t !== undefined && save();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
})();

render(() => <App />, document.getElementById("root")!);

if (import.meta.env.DEV) {
  // Debug handle for devtools: __openbone.store.doc, __openbone.sm()?.activeStates
  import("./panels/Viewport.tsx").then((v) => {
    (window as unknown as Record<string, unknown>).__openbone = { store, sm: v.smInstance };
  });
}
