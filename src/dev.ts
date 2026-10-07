/** Local development server: the same handler as the deployed worker, plus the static page from ./site. */
import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import worker from "./worker.ts";

const SITE = new URL("../site/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".css": "text/css" };

const assets = {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const file = normalize(join(SITE, path === "/" ? "index.html" : decodeURIComponent(path)));
    if (!file.startsWith(normalize(SITE)) || file.endsWith("_worker.js")) return new Response("Not found", { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (request: Request) => worker.fetch(request, { ASSETS: assets }), port });
console.log(`Aurora Odds MCP: page http://localhost:${port}/  endpoint http://localhost:${port}/mcp`);
