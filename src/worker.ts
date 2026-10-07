/**
 * HTTP entry: MCP over Streamable HTTP at /mcp (spec 2025-11-25), stateless, so any instance can answer any
 * request. /assistant is the voice demo's host: a model on Workers AI picks the tool, then calls /mcp like any client.
 * Runs on Cloudflare (Pages advanced mode `_worker.js` or Workers) and, through src/dev.ts, on Node.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, SERVER_INFO } from "./server.ts";
import { answer, MODELS, type Ai } from "./assistant.ts";

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

export async function handleMcp(request: Request, makeServer: () => McpServer = createServer): Promise<Response> {
  // One server per request: stateless mode keeps no sessions, so there is nothing to share between requests.
  const server = makeServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}

// A light guard for the free model quota: per isolate, per caller, per minute.
const recent = new Map<string, number[]>();
function tooMany(key: string, perMinute = 12): boolean {
  const now = Date.now();
  const hits = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();
  return hits.length > perMinute;
}

async function handleAssistant(request: Request, url: URL, ai: Ai): Promise<Response> {
  if (tooMany(request.headers.get("cf-connecting-ip") ?? "local")) {
    return Response.json({ error: "Too many questions in a minute. Try again shortly." }, { status: 429 });
  }
  let body: { text?: unknown; latitude?: unknown; longitude?: unknown; model?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON: {\"text\": \"...\"}" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 300) : "";
  if (!text) return Response.json({ error: "Nothing was heard." }, { status: 400 });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const latitude = num(body.latitude);
  const longitude = num(body.longitude);
  // The assistant talks to the MCP endpoint over Streamable HTTP; the fetch is routed in-process because a Worker
  // cannot call its own hostname.
  const models = typeof body.model === "string" && MODELS.includes(body.model) ? [body.model] : undefined;
  const reply = await answer(
    { text, latitude, longitude },
    { ai, mcpUrl: `${url.origin}/mcp`, fetch: (input, init) => handleMcp(new Request(input, init)), models },
  );
  return Response.json(reply);
}

interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AI?: Ai;
}

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
    if (url.pathname === "/assistant" && request.method === "POST") {
      if (!env.AI) return Response.json({ error: "No language model is configured here." }, { status: 501 });
      try {
        return await handleAssistant(request, url, env.AI);
      } catch (error) {
        console.error("assistant failed:", error);
        return Response.json({ error: "The assistant couldn't answer just now." }, { status: 502 });
      }
    }
    if (url.pathname === "/health") return withCors(Response.json({ ok: true, server: SERVER_INFO, endpoint: `${url.origin}/mcp` }));
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Aurora Odds MCP server. The MCP endpoint is /mcp.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
