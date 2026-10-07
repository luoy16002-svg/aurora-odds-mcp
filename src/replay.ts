/**
 * Replays of past nights, served on their own MCP endpoint (/replay/<name>/mcp) with the forecast the model made that
 * night and the clock stopped at that moment. Places and time zones are looked up live. Cloud cover and NOAA's
 * outlook from that night are not stored, so the replay leaves clouds out and carries the model's value forward.
 */
import may2024 from "./replays/may-2024.json" with { type: "json" };
import type { Nowcast, Sources } from "./sources.ts";

export interface Replay {
  label: string;
  at: string;
  nowcast: Nowcast;
}

export const REPLAYS: Record<string, Replay> = {
  // The strongest geomagnetic storm since 2003; the aurora was seen across Britain, Europe and the United States.
  may2024: { label: "10 May 2024, 22:00 UTC", at: "2024-05-10T22:00:00Z", nowcast: may2024 as Nowcast },
};

export function replaySources(live: Sources, replay: Replay): Sources {
  return {
    nowcast: async () => replay.nowcast,
    findPlace: (query) => live.findPlace(query),
    weather: async (lat, lon) => {
      const now = await live.weather(lat, lon);
      return now ? { ...now, cloudNow: null, cloudByHour: new Map() } : null;
    },
    kpForecast: async () => [],
  };
}
