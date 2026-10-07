/**
 * HTTP entry: MCP over Streamable HTTP at /mcp (spec 2025-11-25), stateless, so any instance can answer any
 * request. Runs on Cloudflare (Pages advanced mode `_worker.js` or Workers) and, through src/dev.ts, on Node.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, SERVER_INFO } from "./server.ts";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleMcp(request: Request): Promise<Response> {
  // One server per request: stateless mode keeps no sessions, so there is nothing to share between requests.
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}

interface Env { ASSETS?: { fetch(request: Request): Promise<Response> } }

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      try {
        return withCors(await handleMcp(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return withCors(Response.json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }, { status: 500 }));
      }
    }
    if (url.pathname === "/health") return withCors(Response.json({ ok: true, server: SERVER_INFO, endpoint: `${url.origin}/mcp` }));
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Aurora Odds MCP server. The MCP endpoint is /mcp.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
