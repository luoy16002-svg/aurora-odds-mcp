/**
 * Live inputs: the Aurora Odds nowcast (TabPFN over the solar wind, rerun every ten minutes), place search and
 * hourly cloud cover from Open-Meteo, and NOAA SWPC's three-day Kp forecast. All free, no keys.
 */

export const NOWCAST_URL = "https://luoy16002-svg.github.io/aurora-odds/data/nowcast.json";
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const KP_FORECAST_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
const USER_AGENT = "aurora-odds-mcp/1.0 (+https://github.com/luoy16002-svg/aurora-odds-mcp)";

export interface Nowcast {
  generated: string;
  model?: string;
  /** Activity levels (Hp30, on the Kp scale) at which `now.exceed` is given. */
  levels: number[];
  now: {
    time: string;
    /** P(highest Hp30 in the coming hour >= levels[i]). */
    exceed: number[];
    median: number;
    /** Minutes of solar wind already measured upstream and still on its way. */
    ahead_minutes: number;
    bz: number;
    bz_min_ahead: number;
    speed: number;
    density: number;
    bt: number;
  };
}

export interface Place {
  name: string;
  region?: string;
  country?: string;
  latitude: number;
  longitude: number;
}

export interface Weather {
  timezone: string;
  utcOffsetSeconds: number;
  /** Cloud cover now, percent. */
  cloudNow: number | null;
  /** Hourly cloud cover, percent, keyed by UTC hour start (ms). */
  cloudByHour: Map<number, number>;
}

export interface KpBlock {
  /** Start of the three-hour block (UTC). */
  start: Date;
  kp: number;
  observed: boolean;
}

/** Everything the report needs, so tests and the server can swap the network for fixtures. */
export interface Sources {
  nowcast(): Promise<Nowcast>;
  findPlace(query: string): Promise<Place | null>;
  weather(lat: number, lon: number): Promise<Weather | null>;
  kpForecast(): Promise<KpBlock[]>;
}

/** Thrown when an upstream service cannot be reached; the tools turn it into a spoken apology. */
export class UpstreamError extends Error {}

async function getJson<T>(url: string, timeoutMs = 6000, attempts = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return (await response.json()) as T;
      last = new Error(`${new URL(url).host} answered ${response.status}`);
      if (response.status < 500 && response.status !== 429) break; // a 4xx will not get better on retry
    } catch (error) {
      last = error;
    }
  }
  throw new UpstreamError(`${new URL(url).host}: ${last instanceof Error ? last.message : String(last)}`);
}

/** A small time-based cache; Workers keep module state between requests on the same isolate. */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

interface GeocodeResponse {
  results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string; population?: number }[];
}
interface ForecastResponse {
  timezone: string;
  utc_offset_seconds: number;
  current?: { cloud_cover?: number };
  hourly?: { time: string[]; cloud_cover: (number | null)[] };
}
interface KpRow { time_tag: string; kp: number; observed: string }

export const liveSources: Sources = {
  nowcast: () => cached("nowcast", 2 * 60_000, () => getJson<Nowcast>(`${NOWCAST_URL}?t=${Math.floor(Date.now() / 120_000)}`)),

  findPlace: (query: string) =>
    cached(`place:${query.toLowerCase()}`, 24 * 3600_000, async () => {
      // "Tromsø, Norway" -> search the town, prefer a result in the named country or region.
      const [town, ...rest] = query.split(",").map((s) => s.trim()).filter(Boolean);
      if (!town) return null;
      const hint = rest.join(" ").toLowerCase();
      const url = `${GEOCODE_URL}?name=${encodeURIComponent(town)}&count=10&language=en&format=json`;
      const { results = [] } = await getJson<GeocodeResponse>(url);
      if (!results.length) return null;
      const matches = hint
        ? results.filter((r) => `${r.country ?? ""} ${r.admin1 ?? ""}`.toLowerCase().includes(hint))
        : results;
      const best = (matches.length ? matches : results)[0];
      return { name: best.name, region: best.admin1, country: best.country, latitude: best.latitude, longitude: best.longitude };
    }),

  weather: (lat: number, lon: number) =>
    cached(`wx:${lat.toFixed(2)},${lon.toFixed(2)}`, 20 * 60_000, async () => {
      const url = `${FORECAST_URL}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=cloud_cover&hourly=cloud_cover&forecast_hours=24&timezone=auto`;
      try {
        const j = await getJson<ForecastResponse>(url);
        const cloudByHour = new Map<number, number>();
        (j.hourly?.time ?? []).forEach((local, i) => {
          const value = j.hourly?.cloud_cover[i];
          // Open-Meteo returns local wall-clock times; shift them back to UTC with the offset.
          if (value != null) cloudByHour.set(Date.parse(`${local}:00Z`) - j.utc_offset_seconds * 1000, value);
        });
        return { timezone: j.timezone, utcOffsetSeconds: j.utc_offset_seconds, cloudNow: j.current?.cloud_cover ?? null, cloudByHour };
      } catch {
        return null; // clouds are a nice-to-have; the answer still works without them
      }
    }),

  kpForecast: () =>
    cached("kp", 30 * 60_000, async () => {
      const rows = await getJson<KpRow[]>(KP_FORECAST_URL);
      return rows.map((r) => ({ start: new Date(`${r.time_tag}Z`), kp: r.kp, observed: r.observed === "observed" }));
    }),
};
