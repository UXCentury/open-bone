import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { logActivity } from "../activity.ts";
import { projectFilePath } from "../storage.ts";
import { toast } from "../state.ts";

const [open, setOpen] = createSignal(false);
export const openMcpConfig = () => setOpen(true);

/** Server arguments: opens the project being edited at startup when the desktop app knows its path. */
function serverArgs(withProject: boolean): string[] {
  const file = projectFilePath();
  return ["-y", "@openbone/mcp", ...(withProject && file ? ["--project", file] : [])];
}

function configs(withProject: boolean) {
  const args = serverArgs(withProject);
  const json = JSON.stringify({ mcpServers: { openbone: { command: "npx", args } } }, null, 2);
  const quote = (a: string) => (/^[\w@./:-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);
  return [
    {
      id: "json",
      title: "MCP config (JSON)",
      where: "Claude Desktop (claude_desktop_config.json), Cursor (.cursor/mcp.json), Windsurf, VS Code and most MCP clients",
      text: json,
    },
    {
      id: "claude-code",
      title: "Claude Code",
      where: "Run in a terminal (or put the JSON above in your project's .mcp.json)",
      text: `claude mcp add openbone -- npx ${args.map(quote).join(" ")}`,
    },
    {
      id: "http",
      title: "HTTP (streamable)",
      where: "For clients that connect to a URL: start the server with this command, then add http://127.0.0.1:7718/mcp",
      text: `npx ${[...args, "--http", "7718"].map(quote).join(" ")}`,
    },
  ];
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
    logActivity("system", `Copied the ${what}`);
  } catch {
    toast("Couldn't copy: select the text and copy it yourself", "error");
  }
}

/** "{ } MCP config" button: shows the JSON (and commands) to add the OpenBone MCP server to an AI client. */
export function McpConfigButton(p: { compact?: boolean }) {
  return (
    <button title="Show the config to add the OpenBone MCP server to Claude, Cursor or another AI client (copy and paste)" onClick={() => setOpen(true)}>
      {p.compact ? "{ }" : "{ } MCP config"}
    </button>
  );
}

/** Dialog with copyable MCP client configs. Mounted once in the app. */
export function McpConfigDialog() {
  return (
    <Show when={open()}>
      <McpConfigModal />
    </Show>
  );
}

function McpConfigModal() {
  const [withProject, setWithProject] = createSignal(true);
  const close = () => setOpen(false);
  onMount(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), close());
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal mcp-config-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-config-title">
        <header class="modal-head">
          <h2 id="mcp-config-title">Connect an AI agent</h2>
          <button class="icon-btn close" title="Close (Esc)" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>
        <div class="mcp-config-body">
          <p class="muted small">
            Add the OpenBone MCP server to your AI client with one of these, restart the client, then press <b>⚡ Connect MCP</b> here to
            watch the agent's edits live. It needs Node.js 20 or newer.
          </p>
          <Show when={projectFilePath()}>
            <label class="small">
              <input type="checkbox" checked={withProject()} onChange={(e) => setWithProject(e.currentTarget.checked)} /> Open this project (
              {projectFilePath()!.split(/[\\/]/).pop()}) when the server starts
            </label>
          </Show>
          <For each={configs(withProject())}>
            {(c) => (
              <section class="mcp-config-block">
                <div class="mcp-config-title">
                  <b>{c.title}</b>
                  <button class="primary" onClick={() => void copy(c.text, c.title)}>
                    Copy
                  </button>
                </div>
                <div class="muted small">{c.where}</div>
                <pre class="selectable">{c.text}</pre>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
