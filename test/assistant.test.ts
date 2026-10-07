import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, readToolCall, MODELS, type Ai } from "../src/assistant.ts";
import { handleMcp } from "../src/worker.ts";
import { createServer } from "../src/server.ts";
import type { Sources } from "../src/sources.ts";
import { storm, quiet, sources } from "./fixtures.ts";

/** A stand-in for the Workers AI binding that records what it was asked and replies with a canned output. */
function fakeAi(reply: unknown | ((model: string) => unknown)): Ai & { calls: { model: string; input: any }[] } {
  const calls: { model: string; input: any }[] = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const out = typeof reply === "function" ? (reply as (m: string) => unknown)(model) : reply;
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

/** The assistant reaches the MCP server over Streamable HTTP, served in-process from recorded data. */
function deps(ai: Ai, src: Sources, at: string) {
  return {
    ai,
    mcpUrl: "https://aurora.test/mcp",
    fetch: (input: string | URL, init?: RequestInit) => handleMcp(new Request(input, init), () => createServer(src, () => new Date(at))),
  };
}

test("reads tool calls in both Workers AI shapes", () => {
  assert.deepEqual(readToolCall({ tool_calls: [{ name: "check_aurora_now", arguments: { place: "Oslo" } }] }), { name: "check_aurora_now", arguments: { place: "Oslo" } });
  assert.deepEqual(
    readToolCall({ tool_calls: [{ id: "1", type: "function", function: { name: "plan_aurora_tonight", arguments: '{"place":"Tromsø"}' } }] }),
    { name: "plan_aurora_tonight", arguments: { place: "Tromsø" } },
  );
  assert.equal(readToolCall({ response: "Hello" }), null);
});

test("the model picks the tool, MCP answers, and the server's sentence is what gets said", async () => {
  const ai = fakeAi({ response: null, tool_calls: [{ name: "check_aurora_now", arguments: { place: "Edinburgh" } }] });
  const reply = await answer({ text: "Can I see the northern lights in Edinburgh right now?" }, deps(ai, sources(storm, 10), "2024-05-10T22:00:00Z"));
  assert.equal(reply.tool, "check_aurora_now");
  assert.deepEqual(reply.arguments, { place: "Edinburgh" });
  assert.match(reply.speech, /^Yes, go outside now/);
  assert.equal((reply.structuredContent as any).verdict, "go_outside");
  assert.equal(reply.model, MODELS[0]);
  const sent = ai.calls[0].input;
  assert.deepEqual(sent.tools.map((t: any) => t.name).sort(), ["check_aurora_now", "explain_space_weather", "plan_aurora_tonight"]);
  assert.equal(sent.tools[0].parameters.type, "object", "tools carry their JSON Schema from tools/list");
  assert.match(sent.messages[0].content, /No device location/);
});

test("device location reaches the tool, with numbers coerced", async () => {
  const ai = fakeAi({ tool_calls: [{ type: "function", function: { name: "plan_aurora_tonight", arguments: '{"latitude":"55.95","longitude":-3.19,"place":""}' } }] });
  const reply = await answer({ text: "Should I go out tonight?", latitude: 55.95, longitude: -3.19 }, deps(ai, sources(quiet), "2026-10-07T13:00:00Z"));
  assert.match(ai.calls[0].input.messages[0].content, /latitude 55\.950, longitude -3\.190/);
  assert.deepEqual(reply.arguments, { latitude: 55.95, longitude: -3.19 });
  assert.equal(reply.tool, "plan_aurora_tonight");
  assert.match(reply.speech, /your location/);
});

test("without a tool call only a short question gets through; anything else gets the fixed line", async () => {
  const asking = await answer({ text: "Can I see the aurora tonight?" }, deps(fakeAi({ response: "Which town are you in?" }), sources(quiet), "2026-10-07T13:00:00Z"));
  assert.equal(asking.speech, "Which town are you in?");
  assert.equal(asking.tool, null);
  const chatty = await answer({ text: "Tell me a joke" }, deps(fakeAi({ response: "The aurora is caused by solar wind hitting oxygen." }), sources(quiet), "2026-10-07T13:00:00Z"));
  assert.match(chatty.speech, /^I can help with the northern and southern lights/);
});

test("falls back to the next model when one fails", async () => {
  const ai = fakeAi((model: string) => (model === MODELS[0] ? new Error("capacity") : { tool_calls: [{ name: "explain_space_weather", arguments: {} }] }));
  const reply = await answer({ text: "What is the Sun doing?" }, deps(ai, sources(quiet), "2026-10-07T22:00:00Z"));
  assert.equal(reply.model, MODELS[1]);
  assert.equal(reply.tool, "explain_space_weather");
  assert.match(reply.speech, /solar wind/);
});

test("a made-up place is dropped, and the device location stands in for it", async () => {
  const ai = fakeAi({ tool_calls: [{ name: "plan_aurora_tonight", arguments: { place: "unknown" } }] });
  const withLocation = await answer({ text: "Can I see it tonight?", latitude: 55.95, longitude: -3.19 }, deps(ai, sources(quiet), "2026-10-07T13:00:00Z"));
  assert.deepEqual(withLocation.arguments, { latitude: 55.95, longitude: -3.19 });
  const without = await answer({ text: "Can I see it tonight?" }, deps(ai, sources(quiet), "2026-10-07T13:00:00Z"));
  assert.deepEqual(without.arguments, {});
  assert.equal(without.isError, true);
  assert.match(without.speech, /Which town or city should I check/);
});

test("a town the person never said is dropped; spelling and accents may differ", async () => {
  const ai = fakeAi({ tool_calls: [{ name: "plan_aurora_tonight", arguments: { place: "Fairbanks, Alaska" } }] });
  const reply = await answer({ text: "Can I see the aurora tonight?" }, deps(ai, sources(quiet), "2026-10-07T13:00:00Z"));
  assert.deepEqual(reply.arguments, {});
  assert.match(reply.speech, /Which town or city should I check/);
  const { placeWasSaid } = await import("../src/assistant.ts");
  assert.equal(placeWasSaid("Tromsø, Norway", "northern lights in tromso tonight"), true);
  assert.equal(placeWasSaid("Reykjavík", "Reykjavik, Iceland?"), true);
  assert.equal(placeWasSaid("Edinburgh, Scotland", "can I see it in Edinburgh"), true);
});
