import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import type { Sources, Nowcast, KpBlock, Weather } from "../src/sources.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8")) as Nowcast;
const storm = load("storm-2024-05-10.json");
const quiet = load("quiet-2026-10-07.json");

const PLACES: Record<string, { name: string; country: string; latitude: number; longitude: number }> = {
  edinburgh: { name: "Edinburgh", country: "United Kingdom", latitude: 55.952, longitude: -3.196 },
  london: { name: "London", country: "United Kingdom", latitude: 51.509, longitude: -0.126 },
  singapore: { name: "Singapore", country: "Singapore", latitude: 1.29, longitude: 103.85 },
  hobart: { name: "Hobart", country: "Australia", latitude: -42.88, longitude: 147.33 },
  "tromsø": { name: "Tromsø", country: "Norway", latitude: 69.649, longitude: 18.955 },
  longyearbyen: { name: "Longyearbyen", country: "Svalbard and Jan Mayen", latitude: 78.223, longitude: 15.647 },
};

function weather(cloud: number, offsetSeconds = 3600): Weather {
  const cloudByHour = new Map<number, number>();
  const base = Math.floor(Date.parse("2024-05-10T00:00:00Z") / 3600_000) * 3600_000;
  for (let h = 0; h < 72; h++) cloudByHour.set(base + h * 3600_000, cloud);
  return { timezone: "Europe/London", utcOffsetSeconds: offsetSeconds, cloudNow: cloud, cloudByHour };
}

function sources(nowcast: Nowcast, cloud = 20, kp: KpBlock[] = []): Sources {
  return {
    nowcast: async () => nowcast,
    findPlace: async (q) => PLACES[q.split(",")[0].trim().toLowerCase()] ?? null,
    weather: async () => weather(cloud),
    kpForecast: async () => kp,
  };
}

async function connect(src: Sources, at: string) {
  const server = createServer(src, () => new Date(at));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("lists three read-only tools with output schemas and two resources", async () => {
  const client = await connect(sources(quiet), "2026-10-07T22:00:00Z");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_aurora_now", "explain_space_weather", "plan_aurora_tonight"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is read-only`);
    assert.ok(tool.outputSchema, `${tool.name} declares its output`);
  }
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ["aurora://method", "aurora://nowcast/latest"]);
  assert.match(client.getInstructions() ?? "", /speech/);
});

test("the May 2024 superstorm: Edinburgh at 23:00 local is told to go outside, facing north", async () => {
  const client = await connect(sources(storm, 10), "2024-05-10T22:00:00Z");
  const res = await client.callTool({ name: "check_aurora_now", arguments: { place: "Edinburgh" } });
  const out = res.structuredContent as Record<string, any>;
  assert.equal(res.isError, undefined);
  assert.equal(out.verdict, "go_outside");
  assert.ok(out.chance_eyes > 0.9, `chance ${out.chance_eyes}`);
  assert.equal(out.hemisphere, "north");
  assert.match(out.speech, /^Yes, go outside now/);
  assert.match((res.content as any[])[0].text, /Edinburgh/);
});

test("a quiet afternoon: still light, with the time it gets dark", async () => {
  const client = await connect(sources(quiet), "2026-10-07T13:00:00Z");
  const out = (await client.callTool({ name: "check_aurora_now", arguments: { place: "Edinburgh" } })).structuredContent as Record<string, any>;
  assert.equal(out.verdict, "too_light");
  assert.ok(out.dark_from_local, "says when it gets dark");
  assert.match(out.speech, /It gets dark enough at about \d/);
});

test("clouds win over a strong storm", async () => {
  const client = await connect(sources(storm, 95), "2024-05-10T22:00:00Z");
  const out = (await client.callTool({ name: "check_aurora_now", arguments: { place: "London" } })).structuredContent as Record<string, any>;
  assert.equal(out.verdict, "too_cloudy");
});

test("the tropics are told the truth, the south faces south", async () => {
  const client = await connect(sources(quiet), "2026-10-07T15:00:00Z");
  const sg = (await client.callTool({ name: "check_aurora_now", arguments: { place: "Singapore" } })).structuredContent as Record<string, any>;
  assert.equal(sg.verdict, "stay_in");
  assert.match(sg.speech, /very rarely reaches Singapore/);
  const hobart = (await client.callTool({ name: "check_aurora_now", arguments: { latitude: -42.88, longitude: 147.33, place: "Hobart" } })).structuredContent as Record<string, any>;
  assert.equal(hobart.hemisphere, "south");
});

test("unknown places and missing input come back as speakable errors", async () => {
  const client = await connect(sources(quiet), "2026-10-07T22:00:00Z");
  const unknown = await client.callTool({ name: "check_aurora_now", arguments: { place: "Nowhereville" } });
  assert.equal(unknown.isError, true);
  assert.match((unknown.content as any[])[0].text, /couldn't find a place called Nowhereville/);
  const missing = await client.callTool({ name: "plan_aurora_tonight", arguments: {} });
  assert.equal(missing.isError, true);
  assert.match((missing.content as any[])[0].text, /Which town or city/);
});

test("tonight's plan picks a dark, clear window when NOAA expects a storm", async () => {
  const kp: KpBlock[] = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({
    start: new Date(Date.parse("2024-05-10T00:00:00Z") + h * 3600_000),
    kp: h === 21 ? 8 : 4,
    observed: false,
  })).concat([{ start: new Date("2024-05-11T00:00:00Z"), kp: 7, observed: false }]);
  const client = await connect(sources(quiet, 15, kp), "2024-05-10T19:00:00Z");
  const out = (await client.callTool({ name: "plan_aurora_tonight", arguments: { place: "Edinburgh" } })).structuredContent as Record<string, any>;
  assert.ok(out.best_window, "there is a window");
  assert.equal(out.best_window.enough_for, "eyes");
  assert.ok(out.hours.some((h: any) => h.kp_source === "noaa"), "later hours come from NOAA");
  assert.ok(out.hours.filter((h: any) => !h.dark).every((h: any) => h.score === 0), "daylight hours never score");
  assert.match(out.speech, /best window is/);
});

test("space weather summary reads the solar wind and NOAA's peak", async () => {
  const kp: KpBlock[] = [{ start: new Date("2026-10-08T21:00:00Z"), kp: 4.67, observed: false }];
  const client = await connect(sources(quiet, 20, kp), "2026-10-07T22:00:00Z");
  const out = (await client.callTool({ name: "explain_space_weather", arguments: {} })).structuredContent as Record<string, any>;
  assert.ok(out.solar_wind.speed_km_s > 200);
  assert.equal(out.noaa.max_kp_next_72h, 4.67);
  assert.match(out.speech, /kilometres per second/);
  assert.match(out.speech, /NOAA's three-day outlook peaks at Kp 4.7/);
});

test("asked in the morning, tonight's plan still covers the coming night", async () => {
  // 09:00 in Tromsø: darkness is about eleven hours away and lasts until dawn.
  const client = await connect(sources(quiet), "2026-10-07T07:00:00Z");
  const out = (await client.callTool({ name: "plan_aurora_tonight", arguments: { place: "Tromsø" } })).structuredContent as Record<string, any>;
  assert.ok(out.dark_from_local && out.dark_until_local, "has a dark window");
  assert.ok(out.hours.some((h: any) => h.dark), "the plan reaches the dark hours");
  assert.ok(Date.parse(out.hours.at(-1).utc) >= Date.parse("2026-10-08T02:00:00Z"), `plan ends at ${out.hours.at(-1).utc}`);
  assert.match(out.speech, /^Tonight in Tromsø it's dark from about/);
  assert.doesNotMatch(out.speech, /doesn't get/);
});

test("the midnight sun gets an honest no", async () => {
  const client = await connect(sources(quiet), "2026-06-21T20:00:00Z");
  const out = (await client.callTool({ name: "plan_aurora_tonight", arguments: { place: "Longyearbyen" } })).structuredContent as Record<string, any>;
  assert.equal(out.dark_from_local, null);
  assert.equal(out.best_window, null);
  assert.match(out.speech, /doesn't get properly dark in Longyearbyen at this time of year/);
});
