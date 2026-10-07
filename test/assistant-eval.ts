/**
 * Asks a deployed /assistant twelve spoken questions and checks what a listener would hear: the right tool with the
 * right place, a question back when no place is known, and no tool for questions that are not about the aurora.
 *   node test/assistant-eval.ts https://aurora-odds-mcp.pages.dev [model-name-filter]
 */
const BASE = process.argv[2] ?? "https://aurora-odds-mcp.pages.dev";
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"].filter((m) => !process.argv[3] || m.includes(process.argv[3]));
const EDINBURGH = { latitude: 55.95, longitude: -3.19 };

interface Reply { speech?: string; tool?: string | null; arguments?: Record<string, unknown> | null; error?: string }
type Check = (r: Reply) => boolean;
const tool = (name: RegExp, args: Record<string, RegExp | number> = {}): Check => (r) =>
  name.test(r.tool ?? "") && Object.entries(args).every(([k, v]) => (v instanceof RegExp ? v.test(String(r.arguments?.[k] ?? "")) : r.arguments?.[k] === v));
const asksWhere: Check = (r) => /which town/i.test(r.speech ?? "");
const declines: Check = (r) => r.tool === null;

const CASES: [string, Check, object?][] = [
  ["Can I see the northern lights in Edinburgh right now?", tool(/^check_aurora_now$/, { place: /Edinburgh/ })],
  ["When should I go out to see the northern lights tonight in Fairbanks, Alaska?", tool(/^plan_aurora_tonight$/, { place: /Fairbanks/ })],
  ["What's the Sun doing right now?", tool(/^explain_space_weather$/)],
  ["Is there a solar storm coming this week?", tool(/^explain_space_weather$/)],
  ["Any chance of the southern lights in Hobart?", tool(/^(check_aurora_now|plan_aurora_tonight)$/, { place: /Hobart/ })],
  ["Should I wake the kids up to see the aurora? We're in Minneapolis.", tool(/^check_aurora_now$/, { place: /Minneapolis/ })],
  ["Can I see the aurora tonight?", asksWhere],
  ["Can I see the aurora tonight?", tool(/^plan_aurora_tonight$/, { latitude: 55.95 }), EDINBURGH],
  ["What's the weather like in Paris?", declines],
  ["Northern lights in Reykjavik, Iceland?", tool(/^(check_aurora_now|plan_aurora_tonight)$/, { place: /Reykjav/ })],
  ["Is it worth driving out of Glasgow tonight to see the northern lights?", tool(/^plan_aurora_tonight$/, { place: /Glasgow/ })],
  ["How high in the sky should I look for the aurora in Oslo?", tool(/^check_aurora_now$/, { place: /Oslo/ })],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const model of MODELS) {
  let passed = 0;
  console.log(`\n${model}`);
  for (const [text, check, location] of CASES) {
    const res = await fetch(`${BASE}/assistant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, model, ...location }) });
    const reply = (await res.json().catch(() => ({}))) as Reply;
    const ok = res.ok && check(reply);
    if (ok) passed++;
    console.log(`  ${ok ? "pass" : "FAIL"}  ${text}${location ? " (device location shared)" : ""}\n        ${reply.tool ?? "no tool"} ${JSON.stringify(reply.arguments ?? null)}: ${(reply.speech ?? reply.error ?? "").slice(0, 90)}`);
    await sleep(5500); // stays under the endpoint's 12-a-minute limit
  }
  console.log(`  ${passed}/${CASES.length}`);
}
