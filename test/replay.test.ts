import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { REPLAYS, replaySources } from "../src/replay.ts";
import { serverFor } from "../src/worker.ts";
import { sources, quiet } from "./fixtures.ts";

test("the replay endpoint is routed, unknown replays are not", () => {
  assert.equal(serverFor("/mcp"), createServer);
  assert.ok(serverFor("/replay/may2024/mcp"));
  assert.equal(serverFor("/replay/nope/mcp"), null);
  assert.equal(serverFor("/replay/may2024"), null);
});

test("replaying 10 May 2024: London is told to go outside, without that night's clouds or NOAA outlook", async () => {
  const live = sources(quiet, 95); // today's sources: a quiet Sun and thick cloud, which the replay must not use
  const replay = REPLAYS.may2024;
  const server = createServer(replaySources(live, replay), () => new Date(replay.at));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const now = (await client.callTool({ name: "check_aurora_now", arguments: { place: "London" } })).structuredContent as Record<string, any>;
  assert.equal(now.verdict, "go_outside");
  assert.equal(now.cloud_cover_pct, null);
  assert.equal(now.model.minutes_old, 0);
  const sun = (await client.callTool({ name: "explain_space_weather", arguments: {} })).structuredContent as Record<string, any>;
  assert.equal(sun.noaa.max_kp_next_72h, null);
  assert.ok(sun.next_hour.expected_kp > 9);
});
