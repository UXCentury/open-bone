import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { type ActivitySource, activityEntries, clearActivity, markActivitySeen } from "../activity.ts";
import { bridgeStatus, connectBridge, disconnectBridge } from "../bridge.ts";
import { McpConfigButton } from "./McpConfig.tsx";

const SOURCE_LABEL: Record<ActivitySource, string> = { you: "You", mcp: "MCP", system: "Editor" };

const clock = (t: number) => {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** Bottom-dock panel: every edit (yours or an agent's over MCP), MCP connection changes and errors, newest last. */
export function ActivityPanel() {
  const [filter, setFilter] = createSignal<"all" | ActivitySource | "errors">("all");
  const shown = createMemo(() => {
    const f = filter();
    const list = activityEntries();
    if (f === "all") return list;
    if (f === "errors") return list.filter((e) => e.level === "error");
    return list.filter((e) => e.source === f);
  });
  let box!: HTMLDivElement;
  let pinned = true; // follow new entries unless the user scrolled up to read
  onMount(() => markActivitySeen());
  onCleanup(() => markActivitySeen());
  createEffect(
    on(shown, () => {
      markActivitySeen();
      if (pinned) queueMicrotask(() => box && (box.scrollTop = box.scrollHeight));
    }),
  );
  return (
    <div class="activity-panel">
      <div class="activity-head">
        <span class="activity-mcp" classList={{ on: bridgeStatus() === "connected" }}>
          <span class="dot" aria-hidden="true" />
          {bridgeStatus() === "connected" ? "MCP connected" : bridgeStatus() === "connecting" ? "MCP connecting…" : "MCP not connected"}
        </span>
        <Show
          when={bridgeStatus() === "connected"}
          fallback={
            <button disabled={bridgeStatus() === "connecting"} onClick={() => connectBridge()} title="Connect to a running OpenBone MCP server">
              Connect
            </button>
          }
        >
          <button onClick={disconnectBridge}>Disconnect</button>
        </Show>
        <McpConfigButton />
        <span class="spacer" />
        <div class="seg" role="tablist" aria-label="Show">
          <For each={[["all", "All"], ["mcp", "MCP"], ["you", "You"], ["errors", "Errors"]] as const}>
            {([id, label]) => (
              <button role="tab" aria-selected={filter() === id} classList={{ active: filter() === id }} onClick={() => setFilter(id)}>
                {label}
              </button>
            )}
          </For>
        </div>
        <button class="link" disabled={!activityEntries().length} onClick={clearActivity}>
          Clear
        </button>
      </div>
      <div
        class="activity-list selectable"
        ref={box}
        aria-live="polite"
        onScroll={() => (pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24)}
      >
        <For
          each={shown()}
          fallback={
            <div class="muted small activity-empty">
              Edits you make, changes an AI agent makes over MCP, connections and errors appear here.
            </div>
          }
        >
          {(e) => (
            <div class={`activity-row src-${e.source}`} classList={{ error: e.level === "error" }}>
              <time class="muted">{clock(e.time)}</time>
              <span class="activity-src">{SOURCE_LABEL[e.source]}</span>
              <span class="activity-text">
                {e.text}
                <Show when={e.count > 1}>
                  <span class="muted"> ×{e.count}</span>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
