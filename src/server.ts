/**
 * The MCP server: three read-only tools and two resources. Every tool returns a `speech` string written to be read
 * aloud as-is, plus structured content for clients that want the numbers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assessNow, planTonight, spaceWeather } from "./report.ts";
import { liveSources, NOWCAST_URL, type Sources, type Place } from "./sources.ts";

export const SERVER_INFO = { name: "aurora-odds", title: "Aurora Odds", version: "1.0.0", websiteUrl: "https://github.com/luoy16002-svg/aurora-odds-mcp" };

const INSTRUCTIONS = `Aurora Odds answers "can I see the northern lights?" (or the southern lights) for one place.
Pass the user's town as \`place\` ("Edinburgh", "Fairbanks, Alaska", "Hobart, Australia"), or latitude and longitude
when the device location is known. Each result has a \`speech\` field written to be read aloud unchanged; prefer it
over composing your own sentence. Use check_aurora_now for "right now" questions, plan_aurora_tonight for "tonight" or
"when should I go out", and explain_space_weather for "what is the Sun doing" or "is there a storm".`;

const placeInput = {
  place: z.string().min(2).max(120).optional().describe('Town or city, optionally with region or country, e.g. "Tromsø, Norway"'),
  latitude: z.number().min(-90).max(90).optional().describe("Latitude in degrees, if the device location is known"),
  longitude: z.number().min(-180).max(180).optional().describe("Longitude in degrees, if the device location is known"),
};

const placeOut = z.object({
  name: z.string(), region: z.string().optional(), country: z.string().optional(),
  latitude: z.number(), longitude: z.number(), timezone: z.string().optional(),
});
const lookOut = z.object({
  bearing: z.number(), compass: z.string(), compassWords: z.string(), overhead: z.boolean(), distanceKm: z.number(),
  lowerDeg: z.number(), upperDeg: z.number(), visible: z.boolean(), fists: z.number(), at_kp: z.number(),
});

const nowOutput = {
  place: placeOut,
  verdict: z.enum(["go_outside", "worth_a_look", "bring_your_phone", "maybe_later", "stay_in", "too_light", "too_cloudy"]),
  headline: z.string(),
  speech: z.string(),
  chance_eyes: z.number().describe("Probability the aurora is bright enough to see by eye in the next hour"),
  chance_camera: z.number().describe("Probability a phone camera in night mode would catch it in the next hour"),
  kp_needed_eyes: z.number(),
  kp_needed_camera: z.number(),
  magnetic_latitude: z.number(),
  hemisphere: z.enum(["north", "south"]),
  dark: z.boolean(),
  sun_altitude_deg: z.number(),
  dark_from_local: z.string().nullable(),
  cloud_cover_pct: z.number().nullable(),
  look: lookOut,
  model: z.object({ name: z.string(), run_at: z.string(), minutes_old: z.number(), horizon_minutes: z.number(), expected_kp: z.number() }),
};

const hourOut = z.object({
  local_time: z.string(), utc: z.string(), dark: z.boolean(), sun_altitude_deg: z.number(), kp_expected: z.number(),
  kp_source: z.enum(["aurora-odds", "noaa"]), chance_eyes: z.number().nullable(), cloud_cover_pct: z.number().nullable(),
  enough_for: z.enum(["eyes", "camera", "neither"]), score: z.number(),
});
const tonightOutput = {
  place: placeOut,
  speech: z.string(),
  dark_from_local: z.string().nullable(),
  dark_until_local: z.string().nullable(),
  kp_needed_eyes: z.number(),
  kp_needed_camera: z.number(),
  best_window: z.object({ from_local: z.string(), to_local: z.string(), kp_expected: z.number(), cloud_cover_pct: z.number().nullable(), enough_for: z.string() }).nullable(),
  hours: z.array(hourOut),
};

const spaceOutput = {
  speech: z.string(),
  solar_wind: z.object({ speed_km_s: z.number(), density_cm3: z.number(), bz_nt: z.number(), bz_min_on_its_way_nt: z.number(), bt_nt: z.number(), on_its_way_minutes: z.number() }),
  next_hour: z.object({ expected_kp: z.number(), chance_kp5_or_more: z.number(), chance_kp7_or_more: z.number() }),
  noaa: z.object({ max_kp_next_24h: z.number().nullable(), max_kp_next_72h: z.number().nullable(), peak_utc: z.string().nullable() }),
  model: z.object({ run_at: z.string(), minutes_old: z.number() }),
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** A spoken error the assistant can relay. */
const sorry = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** Runs a tool body so a slow or failing data source becomes a sentence instead of a stack trace. */
async function guard(body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    console.error("tool failed:", error);
    return sorry("I couldn't reach the space-weather data just now. Please ask me again in a minute.");
  }
}

async function resolvePlace(sources: Sources, args: { place?: string; latitude?: number; longitude?: number }): Promise<Place | string> {
  if (args.latitude != null && args.longitude != null) {
    return { name: args.place?.trim() || "your location", latitude: args.latitude, longitude: args.longitude };
  }
  if (!args.place) return "Which town or city should I check? Tell me the place, or share your location.";
  const found = await sources.findPlace(args.place);
  return found ?? `I couldn't find a place called ${args.place}. Try the nearest town, or add the country.`;
}

export function createServer(sources: Sources = liveSources, clock: () => Date = () => new Date()): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "check_aurora_now",
    {
      title: "Can I see the aurora right now?",
      description:
        "Whether it is worth going outside to see the northern or southern lights at a place in the next hour: the chance it is bright enough for the eyes and for a phone camera, whether it is dark, how cloudy it is, and which way and how high to look. Uses a TabPFN nowcast of the solar wind that is already on its way to Earth, updated every ten minutes.",
      inputSchema: placeInput,
      outputSchema: nowOutput,
      annotations: { title: "Aurora right now", ...readOnly },
    },
    async (args) => guard(async () => {
      const place = await resolvePlace(sources, args);
      if (typeof place === "string") return sorry(place);
      const [nowcast, weather] = await Promise.all([sources.nowcast(), sources.weather(place.latitude, place.longitude)]);
      const report = assessNow({ place, nowcast, weather, at: clock() });
      return { content: [{ type: "text", text: report.speech }], structuredContent: { ...report } };
    }),
  );

  server.registerTool(
    "plan_aurora_tonight",
    {
      title: "When should I go out tonight?",
      description:
        "Hour-by-hour aurora outlook for tonight at a place: when it is dark, the expected activity (next hour from the Aurora Odds model, later hours from NOAA's three-day Kp forecast), cloud cover each hour, and the best window to go out.",
      inputSchema: placeInput,
      outputSchema: tonightOutput,
      annotations: { title: "Aurora tonight", ...readOnly },
    },
    async (args) => guard(async () => {
      const place = await resolvePlace(sources, args);
      if (typeof place === "string") return sorry(place);
      const [nowcast, weather, kp] = await Promise.all([sources.nowcast(), sources.weather(place.latitude, place.longitude), sources.kpForecast()]);
      const report = planTonight({ place, nowcast, weather, kp, at: clock() });
      return { content: [{ type: "text", text: report.speech }], structuredContent: { ...report } };
    }),
  );

  server.registerTool(
    "explain_space_weather",
    {
      title: "What is the Sun doing?",
      description:
        "Plain-language summary of the solar wind now (speed, density, magnetic field direction), the expected geomagnetic activity in the next hour with the chance of a storm, and the peak of NOAA's three-day Kp outlook.",
      inputSchema: {},
      outputSchema: spaceOutput,
      annotations: { title: "Space weather now", ...readOnly },
    },
    async () => guard(async () => {
      const [nowcast, kp] = await Promise.all([sources.nowcast(), sources.kpForecast()]);
      const report = spaceWeather({ nowcast, kp, at: clock() });
      return { content: [{ type: "text", text: report.speech }], structuredContent: { ...report } };
    }),
  );

  server.registerResource(
    "nowcast",
    "aurora://nowcast/latest",
    { title: "Latest Aurora Odds nowcast", description: "Exceedance probabilities for the next hour's Hp30 index and the solar wind behind them.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await sources.nowcast()) }] }),
  );

  server.registerResource(
    "method",
    "aurora://method",
    { title: "How the answer is made", description: "Model, data sources and the visibility rules behind every answer.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: METHOD }] }),
  );

  return server;
}

const METHOD = `# How Aurora Odds answers

- **Activity, next hour.** A TabPFN v2 regressor reads the solar wind measured at the L1 point (NOAA real-time feed),
  shifted to its arrival time at Earth, and returns a full probability distribution for the highest Hp30 index in the
  coming hour. It runs every ten minutes; the latest output is the \`aurora://nowcast/latest\` resource
  (${NOWCAST_URL}). On 2023-2026, years it never saw, it beats LightGBM for strong storms (Brier skill 0.58 vs 0.46 at
  Hp30 >= 7).
- **Activity, later tonight.** NOAA SWPC's three-day Kp forecast (three-hour blocks).
- **Can you see it from there?** Corrected (AACGM-v2) magnetic latitude; the oval's equatorward edge at about 66.5
  degrees at Kp 0, moving 2.04 degrees per Kp; visible by eye about 3.5 degrees beyond the edge and by a phone camera
  about 5.5 degrees beyond it (open-source library aurora-sky).
- **Dark and clear.** The Sun's altitude (dark enough below -12 degrees) and Open-Meteo hourly cloud cover.
`;
