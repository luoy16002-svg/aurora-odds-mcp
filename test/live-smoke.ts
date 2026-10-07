/** Smoke test against a running server over Streamable HTTP with live data: node test/live-smoke.ts [url] */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "http://localhost:8787/mcp");
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));
console.log("server:", client.getServerVersion()?.name, client.getServerVersion()?.version, "| protocol ok");
for (const place of ["Edinburgh", "Fairbanks, Alaska", "Hobart, Australia"]) {
  const res = await client.callTool({ name: "check_aurora_now", arguments: { place } });
  console.log(`\n[now] ${place}:`, (res.content as any[])[0].text);
}
const tonight = await client.callTool({ name: "plan_aurora_tonight", arguments: { place: "Tromsø, Norway" } });
console.log("\n[tonight] Tromsø:", (tonight.content as any[])[0].text);
const sw = await client.callTool({ name: "explain_space_weather", arguments: {} });
console.log("\n[space weather]", (sw.content as any[])[0].text);
await client.close();
