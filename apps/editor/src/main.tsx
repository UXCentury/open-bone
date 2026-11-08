import { deserialize, serialize } from "@openbone/core";
import { get, set } from "idb-keyval";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { fileName, loadDocument, openExample, store } from "./state.ts";
import "./styles.css";

// Restore the last session (autosaved to IndexedDB), else open the walker example.
(async () => {
  try {
    const saved = (await get("openbone.autosave")) as { json: string; name: string } | undefined;
    if (saved) loadDocument(deserialize(saved.json), saved.name, "/examples/");
    else await openExample(new URLSearchParams(location.search).get("example") ?? "walker");
  } catch {
    await openExample("walker");
  }
  let t: ReturnType<typeof setTimeout> | undefined;
  store.subscribe(() => {
    clearTimeout(t);
    t = setTimeout(() => set("openbone.autosave", { json: serialize(store.doc, false), name: fileName() }).catch(() => {}), 500);
  });
})();

render(() => <App />, document.getElementById("root")!);

if (import.meta.env.DEV) {
  // Debug handle for devtools: __openbone.store.doc, __openbone.sm()?.activeStates
  import("./panels/Viewport.tsx").then((v) => {
    (window as unknown as Record<string, unknown>).__openbone = { store, sm: v.smInstance };
  });
}
