/**
 * Who may talk to the local servers (the editor bridge and MCP over HTTP).
 *
 * Both listen on 127.0.0.1, so other machines can't reach them, but any web page open in a browser on this machine
 * can still try: a page can open a WebSocket to ws://127.0.0.1:7717, and with DNS rebinding (a site whose name starts
 * resolving to 127.0.0.1) it can send same-origin HTTP requests. Browsers always say where a request comes from
 * (Origin) and which name it was sent to (Host), so:
 *   - Origin must be absent (CLI tools, MCP clients, scripts: not a browser page) or a local page: the editor's dev
 *     server on localhost/127.0.0.1/[::1] (any port) or the desktop app (tauri://localhost, http(s)://tauri.localhost).
 *   - Host must be a loopback name, which a DNS-rebinding site's name never is.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  let url: URL;
  try {
    url = new URL(origin); // "null" (file://, sandboxed iframes) doesn't parse and is refused
  } catch {
    return false;
  }
  if (url.protocol === "tauri:") return url.hostname === "localhost";
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOCAL_HOSTNAMES.has(url.hostname) || url.hostname === "tauri.localhost";
}

export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTNAMES.has(name.toLowerCase());
}

/** Both checks, for an incoming request's headers. */
export function isLocalRequest(headers: { origin?: string; host?: string }): boolean {
  return isLocalOrigin(headers.origin) && isLocalHost(headers.host);
}
