#!/usr/bin/env -S npx tsx
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startBridge } from "./bridge.ts";
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
  try {
    await session.open(project);
    log(`opened ${session.filePath}`);
  } catch {
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
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
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
