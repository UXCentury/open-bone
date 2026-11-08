import { For, Match, Switch, onCleanup, onMount } from "solid-js";
import { Hierarchy } from "./panels/Hierarchy.tsx";
import { Inspector } from "./panels/Inspector.tsx";
import { ScriptsPanel } from "./panels/ScriptsPanel.tsx";
import { StateMachinePanel } from "./panels/StateMachinePanel.tsx";
import { Timeline } from "./panels/Timeline.tsx";
import { Toolbar, importImages, redo, undo } from "./panels/Toolbar.tsx";
import { Viewport } from "./panels/Viewport.tsx";
import { saveProject } from "./storage.ts";
import { apply, bottomTab, mode, playing, selection, setBottomTab, setPlaying, setSelection, setTool, toasts } from "./state.ts";

export function App() {
  const key = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject(e.shiftKey);
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (!mod) {
      const k = e.key.toLowerCase();
      if (k === "v" || k === "r") setTool("select");
      else if (k === "t") setTool("translate");
      else if (k === "s") setTool("scale");
      else if (k === "b") setTool("bone");
      else if (e.code === "Space" && mode() === "animate") {
        e.preventDefault();
        setPlaying(!playing());
      } else if (k === "delete" || k === "backspace") {
        const s = selection();
        if (s?.kind === "bone") apply("deleteBone", { bone: s.id }) !== undefined && setSelection(null);
        else if (s?.kind === "slot") apply("deleteSlot", { slot: s.id }) !== undefined && setSelection(null);
      } else if (k === "escape") setSelection(null);
    }
  };
  onMount(() => window.addEventListener("keydown", key));
  onCleanup(() => window.removeEventListener("keydown", key));

  return (
    <div class="app">
      <Toolbar />
      <div class="main">
        <Hierarchy />
        <div
          class="center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer?.files.length) importImages(e.dataTransfer.files);
          }}
        >
          <Viewport />
          <div class="bottom">
            <div class="tabs">
              <button classList={{ active: bottomTab() === "timeline" }} onClick={() => setBottomTab("timeline")}>
                Timeline
              </button>
              <button classList={{ active: bottomTab() === "statemachine" }} onClick={() => setBottomTab("statemachine")}>
                State Machine
              </button>
              <button classList={{ active: bottomTab() === "scripts" }} onClick={() => setBottomTab("scripts")}>
                Scripts
              </button>
            </div>
            <div class="tab-body">
              <Switch>
                <Match when={bottomTab() === "timeline"}>
                  <Timeline />
                </Match>
                <Match when={bottomTab() === "statemachine"}>
                  <StateMachinePanel />
                </Match>
                <Match when={bottomTab() === "scripts"}>
                  <ScriptsPanel />
                </Match>
              </Switch>
            </div>
          </div>
        </div>
        <Inspector />
      </div>
      <div class="toasts">
        <For each={toasts()}>{(t) => <div class={`toast ${t.kind}`}>{t.text}</div>}</For>
      </div>
    </div>
  );
}
