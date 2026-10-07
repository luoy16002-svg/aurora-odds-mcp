/**
 * A small voice-assistant host standing in for Alexa+. A language model reads what the person said and picks one of
 * the server's tools with its arguments; the tool is then called over MCP (Streamable HTTP) and its `speech` is read
 * back unchanged, so every number the person hears comes from the server, not from the model.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
// The default validator (Ajv) compiles schemas with `new Function`, which Cloudflare Workers forbid.
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";

/** The slice of the Workers AI binding this file uses. */
export interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Tried in order; the first that answers wins. Both support function calling on Workers AI. */
export const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"];

export interface Heard {
  text: string;
  latitude?: number;
  longitude?: number;
}

export interface AssistantReply {
  speech: string;
  tool: string | null;
  arguments: Record<string, unknown> | null;
  isError: boolean;
  structuredContent: Record<string, unknown> | null;
  model: string | null;
  ms: { model: number; tool: number };
}

const SYSTEM = `You are the northern-lights feature of a voice assistant. You never answer from your own knowledge:
for every question about the aurora, the northern or southern lights, solar storms or space weather, call exactly one
tool. Use check_aurora_now for "right now" or "is it out", plan_aurora_tonight for "tonight", "later" or "when should I
go", and explain_space_weather for questions about the Sun, solar wind or storms in general. Pass the town the person
names as "place", keeping any region or country they say (for example "Fairbanks, Alaska"). If they name no place and a
device location is given, pass its latitude and longitude instead. If they name no place and there is no device
location, ask which town they are in. For anything that is not about the aurora, including ordinary weather, rain or
temperature, call no tool and say in one short sentence that you can only help with the northern and southern lights.`;

const NOT_AURORA = "I can help with the northern and southern lights. Ask me if you can see them now or tonight, and tell me where you are.";

interface ToolCall { name: string; arguments: Record<string, unknown> }

/** Workers AI returns tool calls in either its own shape or the OpenAI one, with arguments as an object or a string. */
export function readToolCall(output: unknown): ToolCall | null {
  const calls = (output as { tool_calls?: unknown[] } | null)?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return null;
  const first = calls[0] as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };
  const name = first.function?.name ?? first.name;
  let args = first.function?.arguments ?? first.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return name ? { name, arguments: (args ?? {}) as Record<string, unknown> } : null;
}

/** Place names a model writes when it has none; a geocoder will happily find a village called "Unknown". */
const NOT_A_PLACE = /^(unknown|unspecified|none|null|n\/?a|here|nearby|current location|my location|your location|the user'?s location|user'?s location|device location|location)$/i;

/** Lower case without accents, so "Tromsø" matches "tromso" and "Reykjavík" matches "reykjavik". */
const fold = (text: string) =>
  [...text.normalize("NFD")]
    .filter((c) => { const n = c.codePointAt(0) ?? 0; return n < 0x300 || n > 0x36f; }) // combining accents
    .join("")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .toLowerCase();

/** The model may only pass a place the person actually said; a town it makes up is dropped. */
export function placeWasSaid(place: string, said: string): boolean {
  const town = fold(place.split(",")[0]).trim();
  return town.length > 1 && fold(said).includes(town);
}

/** Drops empty values, made-up or placeholder places and anything the tool does not declare, and coerces numeric
 * strings. When the person named no place, the device location is used, as a voice assistant would. */
export function cleanArguments(args: Record<string, unknown>, schema: { properties?: Record<string, { type?: string }> }, heard: Heard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const type = schema.properties?.[key]?.type;
    if (!type || value == null || value === "") continue;
    if (type === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n)) out[key] = n;
    } else if (type === "string" && typeof value === "string" && value.trim()) {
      if (key === "place" && (NOT_A_PLACE.test(value.trim()) || !placeWasSaid(value, heard.text))) continue;
      out[key] = value.trim();
    }
  }
  const takesPlace = Boolean(schema.properties?.place && schema.properties?.latitude);
  if (takesPlace && out.place == null && out.latitude == null && heard.latitude != null && heard.longitude != null) {
    out.latitude = heard.latitude;
    out.longitude = heard.longitude;
  }
  return out;
}

export async function answer(heard: Heard, deps: { ai: Ai; mcpUrl: string; fetch?: FetchLike; models?: string[] }): Promise<AssistantReply> {
  const client = new Client({ name: "aurora-odds-voice", version: "1.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  await client.connect(new StreamableHTTPClientTransport(new URL(deps.mcpUrl), deps.fetch ? { fetch: deps.fetch } : undefined));
  try {
    const { tools } = await client.listTools();
    const location = heard.latitude != null && heard.longitude != null
      ? `Device location: latitude ${heard.latitude.toFixed(3)}, longitude ${heard.longitude.toFixed(3)}.`
      : "No device location is shared.";
    const messages = [
      { role: "system", content: `${SYSTEM}\n${location}` },
      { role: "user", content: heard.text },
    ];
    const toolSpecs = tools.map((t) => ({ name: t.name, description: t.description ?? t.title ?? "", parameters: t.inputSchema }));

    const t0 = Date.now();
    let call: ToolCall | null = null;
    let said = "";
    let used: string | null = null;
    let lastError: unknown = null;
    for (const model of deps.models ?? MODELS) {
      try {
        const output = await deps.ai.run(model, { messages, tools: toolSpecs, max_tokens: 256, temperature: 0 });
        used = model;
        call = readToolCall(output);
        said = String((output as { response?: unknown } | null)?.response ?? "").trim();
        break;
      } catch (error) {
        lastError = error;
      }
    }
    const modelMs = Date.now() - t0;
    if (!used) throw lastError ?? new Error("no model answered");

    const tool = call ? tools.find((t) => t.name === call.name) : undefined;
    if (!call || !tool) {
      // No tool: only pass on a short clarifying question; anything else gets a fixed sentence, so the model never
      // gets to state aurora facts of its own.
      const speech = said && said.length <= 200 && said.endsWith("?") ? said : NOT_AURORA;
      return { speech, tool: null, arguments: null, isError: false, structuredContent: null, model: used, ms: { model: modelMs, tool: 0 } };
    }

    const args = cleanArguments(call.arguments, tool.inputSchema as { properties?: Record<string, { type?: string }> }, heard);
    const t1 = Date.now();
    const result = await client.callTool({ name: tool.name, arguments: args });
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "";
    return {
      speech: text,
      tool: tool.name,
      arguments: args,
      isError: result.isError === true,
      structuredContent: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
      model: used,
      ms: { model: modelMs, tool: Date.now() - t1 },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
