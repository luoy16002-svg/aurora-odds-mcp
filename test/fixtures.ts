/** Recorded inputs shared by the tests: two nowcasts, a few places, flat cloud cover. */
import { readFileSync } from "node:fs";
import type { Sources, Nowcast, KpBlock, Weather } from "../src/sources.ts";

export const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8")) as Nowcast;
export const storm = load("storm-2024-05-10.json");
export const quiet = load("quiet-2026-10-07.json");

export const PLACES: Record<string, { name: string; country: string; latitude: number; longitude: number }> = {
  edinburgh: { name: "Edinburgh", country: "United Kingdom", latitude: 55.952, longitude: -3.196 },
  london: { name: "London", country: "United Kingdom", latitude: 51.509, longitude: -0.126 },
  singapore: { name: "Singapore", country: "Singapore", latitude: 1.29, longitude: 103.85 },
  hobart: { name: "Hobart", country: "Australia", latitude: -42.88, longitude: 147.33 },
  "tromsø": { name: "Tromsø", country: "Norway", latitude: 69.649, longitude: 18.955 },
  longyearbyen: { name: "Longyearbyen", country: "Svalbard and Jan Mayen", latitude: 78.223, longitude: 15.647 },
};

export function weather(cloud: number, offsetSeconds = 3600): Weather {
  const cloudByHour = new Map<number, number>();
  const base = Math.floor(Date.parse("2024-05-10T00:00:00Z") / 3600_000) * 3600_000;
  for (let h = 0; h < 72; h++) cloudByHour.set(base + h * 3600_000, cloud);
  return { timezone: "Europe/London", utcOffsetSeconds: offsetSeconds, cloudNow: cloud, cloudByHour };
}

export function sources(nowcast: Nowcast, cloud = 20, kp: KpBlock[] = []): Sources {
  return {
    nowcast: async () => nowcast,
    findPlace: async (q) => PLACES[q.split(",")[0].trim().toLowerCase()] ?? null,
    weather: async () => weather(cloud),
    kpForecast: async () => kp,
  };
}
