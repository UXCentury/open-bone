#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startBridge } from "./bridge.ts";
import { isLocalRequest } from "./local-only.ts";
import { createServer } from "./server.ts";
import { ProjectSession } from "./session.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};
const log = (m: string) => process.stderr.write(`[openbone-mcp] ${m}\n`);

const session = new ProjectSession();
const project = flag("project");
if (project) {
  if (existsSync(project)) {
    // Never replace an existing file: if it can't be read (corrupt, wrong format, newer version), stop and say why.
    try {
      await session.open(project);
    } catch (e) {
      log(`cannot open ${project}: ${(e as Error).message}`);
      log("the file was left unchanged; fix or move it, or pass a different --project path");
      process.exit(1);
    }
    log(`opened ${session.filePath}`);
  } else {
    session.newProject("Untitled", project);
    await session.save();
    log(`created ${session.filePath}`);
  }
}

const bridgePort = Number(flag("bridge-port") ?? process.env.OPENBONE_BRIDGE_PORT ?? 7717);
if (!args.includes("--no-bridge")) startBridge(session, bridgePort, log);

const httpPort = flag("http");
if (httpPort !== undefined) {
  // Streamable HTTP (stateless): a fresh MCP server per request sharing one project session.
  const http = createHttpServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // Refuse browser pages from other sites, including DNS rebinding (see local-only.ts).
    if (!isLocalRequest({ origin: req.headers.origin, host: req.headers.host })) {
      log(`http: refused a request from ${req.headers.origin ?? "?"} for host ${req.headers.host ?? "?"}`);
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden: only local MCP clients and the OpenBone editor\n");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("Bad request: body is not JSON\n");
      return;
    }
    const { server } = createServer({ session });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  http.listen(Number(httpPort) || 7718, "127.0.0.1", () => log(`MCP over HTTP at http://127.0.0.1:${Number(httpPort) || 7718}/mcp`));
} else {
  const { server } = createServer({ session });
  await server.connect(new StdioServerTransport());
  log("MCP server ready on stdio");
}
