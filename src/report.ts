/**
 * Turns the inputs into answers a voice assistant can read out: one verdict, a few numbers, and which way to look.
 * Pure functions; the network lives in sources.ts.
 */
import {
  magneticLatitude, requiredKp, whereToLook, probabilityAtLeast, quantileKp, sunAltitude, nextDarkness, endOfDarkness,
  DARK_ENOUGH_DEG, type LookAdvice,
} from "aurora-sky";
import type { Nowcast, Place, Weather, KpBlock } from "./sources.ts";

export type Verdict = "go_outside" | "worth_a_look" | "bring_your_phone" | "maybe_later" | "stay_in" | "too_light" | "too_cloudy";

export interface PlaceOut { name: string; region?: string; country?: string; latitude: number; longitude: number; timezone?: string }

export interface NowReport {
  place: PlaceOut;
  verdict: Verdict;
  headline: string;
  speech: string;
  chance_eyes: number;
  chance_camera: number;
  kp_needed_eyes: number;
  kp_needed_camera: number;
  magnetic_latitude: number;
  hemisphere: "north" | "south";
  dark: boolean;
  sun_altitude_deg: number;
  dark_from_local: string | null;
  cloud_cover_pct: number | null;
  look: LookAdvice & { at_kp: number };
  model: { name: string; run_at: string; minutes_old: number; horizon_minutes: number; expected_kp: number };
}

export interface HourOut {
  local_time: string;
  utc: string;
  dark: boolean;
  sun_altitude_deg: number;
  kp_expected: number;
  kp_source: "aurora-odds" | "noaa";
  chance_eyes: number | null;
  cloud_cover_pct: number | null;
  enough_for: "eyes" | "camera" | "neither";
  score: number;
}

export interface TonightReport {
  place: PlaceOut;
  speech: string;
  dark_from_local: string | null;
  dark_until_local: string | null;
  kp_needed_eyes: number;
  kp_needed_camera: number;
  best_window: { from_local: string; to_local: string; kp_expected: number; cloud_cover_pct: number | null; enough_for: string } | null;
  hours: HourOut[];
}

export interface SpaceWeatherReport {
  speech: string;
  solar_wind: { speed_km_s: number; density_cm3: number; bz_nt: number; bz_min_on_its_way_nt: number; bt_nt: number; on_its_way_minutes: number };
  next_hour: { expected_kp: number; chance_kp5_or_more: number; chance_kp7_or_more: number };
  noaa: { max_kp_next_24h: number | null; max_kp_next_72h: number | null; peak_utc: string | null };
  model: { run_at: string; minutes_old: number };
}

// ---------- small helpers ----------

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** "about a 35 percent chance", "less than a 1 percent chance", "a near-certain chance". */
export function spokenChance(p: number): string {
  if (p < 0.01) return "less than a 1 percent chance";
  if (p > 0.97) return "a near-certain chance";
  const n = p < 0.1 ? Math.max(1, Math.round(p * 100)) : Math.round(p * 20) * 5;
  const article = /^(8|11|18)/.test(String(n)) ? "an" : "a";
  return `about ${article} ${n} percent chance`;
}

/** NOAA's G scale: Kp 5 is a minor storm (G1) up to Kp 9, extreme (G5). */
export function stormWord(kp: number): string | null {
  if (kp >= 9) return "an extreme storm, G5";
  if (kp >= 8) return "a severe storm, G4";
  if (kp >= 7) return "a strong storm, G3";
  if (kp >= 6) return "a moderate storm, G2";
  if (kp >= 5) return "a minor storm, G1";
  return null;
}

/** Local wall-clock time for speech: "9:40 pm". */
export function spokenTime(date: Date, offsetSeconds: number): string {
  const t = new Date(date.getTime() + offsetSeconds * 1000);
  let h = t.getUTCHours();
  const m = t.getUTCMinutes();
  const ampm = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  if (m === 0) return `${h} ${ampm}`;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Round to the nearest 5 minutes so speech does not say "9:43 pm". */
const roundTo5 = (d: Date) => new Date(Math.round(d.getTime() / 300_000) * 300_000);

function describePlace(place: Place, weather: Weather | null): PlaceOut {
  return { ...place, latitude: round(place.latitude, 3), longitude: round(place.longitude, 3), timezone: weather?.timezone };
}

/** How to say the direction and height, e.g. "Face north-northwest, away from lights. The lower edge should sit
 * about 15 degrees up and the top near 38 degrees, 4 fists at arm's length." A fist at arm's length is about 10 degrees. */
function lookSentence(look: LookAdvice, faceWord: string): string {
  if (look.overhead) return `Look ${faceWord} and straight up: at this level the aurora can spread across the whole sky.`;
  if (!look.visible) return `If it comes, it will be low in the ${look.compassWords} sky, so find a dark spot with a clear view that way.`;
  const lower = Math.max(0, Math.round(look.lowerDeg));
  const upper = Math.round(look.upperDeg);
  const fists = Math.max(1, Math.round(upper / 10));
  const fistWords = `${fists} fist${fists > 1 ? "s" : ""} at arm's length`;
  return lower <= 2
    ? `Face ${look.compassWords}, away from lights, with a clear view of the horizon: it will start right at the horizon and reach about ${upper} degrees, ${fistWords}.`
    : `Face ${look.compassWords}, away from lights. The lower edge should sit about ${lower} degrees up and the top near ${upper} degrees, ${fistWords}.`;
}

// ---------- right now ----------

export function assessNow(args: { place: Place; nowcast: Nowcast; weather: Weather | null; at?: Date }): NowReport {
  const { place, nowcast: nc, weather } = args;
  const at = args.at ?? new Date();
  const { latitude: lat, longitude: lon } = place;
  const offset = weather?.utcOffsetSeconds ?? Math.round(lon / 15) * 3600;
  const mlat = magneticLatitude(lat, lon);
  const south = mlat < 0;
  const needEyes = requiredKp(mlat, "eyes");
  const needCamera = requiredKp(mlat, "camera");
  const pEyes = probabilityAtLeast(nc.now.exceed, nc.levels, needEyes);
  const pCamera = probabilityAtLeast(nc.now.exceed, nc.levels, needCamera);
  const median = quantileKp(nc.now.exceed, nc.levels, 0.5);
  const likelyHigh = quantileKp(nc.now.exceed, nc.levels, 0.1);
  const alt = sunAltitude(at, lat, lon);
  const dark = alt < DARK_ENOUGH_DEG;
  const darkFrom = dark ? null : nextDarkness(lat, lon, at);
  const cloud = weather?.cloudNow ?? null;
  const lookKp = pEyes >= 0.25 ? Math.max(median, needEyes) : likelyHigh;
  const look = { ...whereToLook(lat, lon, lookKp, mlat), at_kp: round(lookKp, 1) };
  const minutesOld = Math.max(0, Math.round((at.getTime() - Date.parse(nc.generated)) / 60_000));
  const name = place.name;
  const faceWord = south ? "south" : "north";
  const lights = south ? "southern lights" : "northern lights";

  let verdict: Verdict;
  let headline: string;
  let speech: string;
  const oddsEyes = `${spokenChance(pEyes)} the ${lights} are bright enough to see with your eyes in ${name} over the next hour`;
  if (alt > -6) {
    verdict = "too_light";
    headline = "Not yet: it's still light out.";
    const when = darkFrom ? `It gets dark enough at about ${spokenTime(roundTo5(darkFrom), offset)}.` : "It doesn't get properly dark there today.";
    const activity = pEyes >= 0.25
      ? `The aurora itself is active: there's ${oddsEyes}, so ask me again once it's dark.`
      : pCamera >= 0.1
        ? `Activity is low for now, with ${spokenChance(pCamera)} a phone camera would catch it over the next hour. Ask me again after dark.`
        : `The Sun is quiet too, with ${spokenChance(pEyes)} of a visible aurora over the next hour.`;
    speech = `Not yet. It's still light in ${name}. ${when} ${activity}`;
  } else if (cloud != null && cloud >= 85) {
    verdict = "too_cloudy";
    headline = "Clouds are in the way.";
    speech = pEyes >= 0.1 || pCamera >= 0.25
      ? `Clouds are in the way: the sky over ${name} is about ${Math.round(cloud)} percent cloud. Above them there's ${oddsEyes}, so keep an eye out for gaps.`
      : `It's about ${Math.round(cloud)} percent cloud over ${name}, and the Sun is quiet anyway: there's ${spokenChance(pEyes)} of a visible aurora in the next hour.`;
  } else if (pEyes >= 0.5) {
    verdict = "go_outside";
    headline = "Go outside now.";
    speech = `Yes, go outside now. There's ${oddsEyes}. ${lookSentence(look, faceWord)}`;
  } else if (pEyes >= 0.25) {
    verdict = "worth_a_look";
    headline = "Worth stepping outside.";
    speech = `It's worth stepping outside. There's ${oddsEyes}. Give your eyes ten minutes to adjust. ${lookSentence(look, faceWord)}`;
  } else if (pCamera >= 0.35) {
    verdict = "bring_your_phone";
    headline = "Bring your phone.";
    speech = `Bring your phone. Your eyes may miss it, but there's ${spokenChance(pCamera)} a night-mode photo facing ${look.compassWords} will catch the ${lights} in the next hour.`;
  } else if (pCamera >= 0.1) {
    verdict = "maybe_later";
    headline = "Maybe later.";
    speech = `Probably not yet. There's ${spokenChance(pCamera)} a phone camera would catch something in ${name} this hour, and ${spokenChance(pEyes)} for your eyes. The forecast updates every ten minutes, so it's worth asking again later.`;
  } else {
    verdict = "stay_in";
    headline = "Stay in. The sky is quiet.";
    const reach = needEyes > 9
      ? `The aurora very rarely reaches ${name}: it takes one of the strongest storms of a decade.`
      : `To see it by eye there you'd need activity around Kp ${needEyes.toFixed(0)}, and the next hour looks like Kp ${median.toFixed(0)}.`;
    speech = `Not this hour. The Sun's wind is quiet and there's ${spokenChance(pEyes)} of a visible aurora in ${name}. ${reach}`;
  }
  if (minutesOld > 45) speech += ` My latest forecast run is ${minutesOld} minutes old, so treat it with care.`;

  return {
    place: describePlace(place, weather),
    verdict,
    headline,
    speech,
    chance_eyes: round(pEyes, 3),
    chance_camera: round(pCamera, 3),
    kp_needed_eyes: round(needEyes, 1),
    kp_needed_camera: round(needCamera, 1),
    magnetic_latitude: round(mlat, 1),
    hemisphere: south ? "south" : "north",
    dark,
    sun_altitude_deg: round(alt, 1),
    dark_from_local: darkFrom ? spokenTime(roundTo5(darkFrom), offset) : null,
    cloud_cover_pct: cloud,
    look,
    model: { name: nc.model ?? "TabPFN v2 over the solar wind", run_at: nc.generated, minutes_old: minutesOld, horizon_minutes: 60, expected_kp: round(median, 1) },
  };
}

// ---------- tonight ----------

/** Smooth 0-1 score for "activity reaches what you need". */
const reach = (kp: number, need: number) => 1 / (1 + Math.exp(-(kp - need) / 0.6));

export function planTonight(args: { place: Place; nowcast: Nowcast; weather: Weather | null; kp: KpBlock[]; at?: Date; hours?: number }): TonightReport {
  const { place, nowcast: nc, weather, kp } = args;
  const at = args.at ?? new Date();
  const { latitude: lat, longitude: lon } = place;
  const offset = weather?.utcOffsetSeconds ?? Math.round(lon / 15) * 3600;
  const mlat = magneticLatitude(lat, lon);
  const needEyes = requiredKp(mlat, "eyes");
  const needCamera = requiredKp(mlat, "camera");
  const nowMedian = quantileKp(nc.now.exceed, nc.levels, 0.5);
  const hourStart = (t: number) => Math.floor(t / 3600_000) * 3600_000;
  // "Tonight" runs from now to the end of the coming dark window, even when asked in the morning.
  const darkFrom = nextDarkness(lat, lon, at);
  const darkUntil = darkFrom ? endOfDarkness(lat, lon, darkFrom) : null;
  const endMs = darkUntil ? darkUntil.getTime() : at.getTime() + 12 * 3600_000;
  const span = args.hours ?? Math.min(24, Math.max(6, Math.ceil((endMs - hourStart(at.getTime())) / 3600_000)));
  const blockFor = (t: number) => kp.find((b) => t >= b.start.getTime() && t < b.start.getTime() + 3 * 3600_000);

  const hours: HourOut[] = [];
  for (let i = 0; i < span; i++) {
    const start = hourStart(at.getTime()) + i * 3600_000;
    const mid = new Date(start + 30 * 60_000);
    const alt = sunAltitude(mid, lat, lon);
    const dark = alt < DARK_ENOUGH_DEG;
    const fromModel = i === 0;
    const block = blockFor(mid.getTime());
    const kpExpected = fromModel ? nowMedian : block?.kp ?? nowMedian;
    const chanceEyes = fromModel ? probabilityAtLeast(nc.now.exceed, nc.levels, needEyes) : null;
    const cloud = weather?.cloudByHour.get(start) ?? null;
    const enough = kpExpected >= needEyes ? "eyes" : kpExpected >= needCamera ? "camera" : "neither";
    const clear = cloud == null ? 0.7 : 1 - cloud / 100;
    const activity = fromModel ? probabilityAtLeast(nc.now.exceed, nc.levels, needCamera) : reach(kpExpected, needCamera);
    hours.push({
      local_time: spokenTime(new Date(start), offset),
      utc: new Date(start).toISOString(),
      dark,
      sun_altitude_deg: round(alt, 1),
      kp_expected: round(kpExpected, 1),
      kp_source: fromModel || !block ? "aurora-odds" : "noaa",
      chance_eyes: chanceEyes == null ? null : round(chanceEyes, 3),
      cloud_cover_pct: cloud,
      enough_for: enough,
      score: round(dark ? activity * clear : 0, 3),
    });
  }

  const best = hours.reduce<HourOut | null>((b, h) => (h.score > (b?.score ?? 0) ? h : b), null);
  let window: TonightReport["best_window"] = null;
  if (best && best.score > 0.02) {
    const i = hours.indexOf(best);
    let a = i;
    let b = i;
    while (a > 0 && hours[a - 1].score >= best.score * 0.8) a--;
    while (b < hours.length - 1 && hours[b + 1].score >= best.score * 0.8) b++;
    const end = new Date(Date.parse(hours[b].utc) + 3600_000);
    const clouds = hours.slice(a, b + 1).map((h) => h.cloud_cover_pct).filter((c): c is number => c != null);
    window = {
      from_local: hours[a].local_time,
      to_local: spokenTime(end, offset),
      kp_expected: Math.max(...hours.slice(a, b + 1).map((h) => h.kp_expected)),
      cloud_cover_pct: clouds.length ? Math.round(clouds.reduce((s, c) => s + c, 0) / clouds.length) : null,
      enough_for: hours.slice(a, b + 1).some((h) => h.enough_for === "eyes") ? "eyes" : hours.slice(a, b + 1).some((h) => h.enough_for === "camera") ? "camera" : "neither",
    };
  }

  const name = place.name;
  const darkHours = hours.filter((h) => h.dark);
  const peak = darkHours.reduce<HourOut | null>((p, h) => (h.kp_expected > (p?.kp_expected ?? -1) ? h : p), null);
  const parts: string[] = [];
  if (!darkHours.length) {
    parts.push(darkFrom
      ? `It doesn't get dark enough in ${name} until about ${spokenTime(roundTo5(darkFrom), offset)}, so ask me again this evening.`
      : `It doesn't get properly dark in ${name} at this time of year, so the aurora can't be seen there tonight.`);
  } else {
    const fromText = darkFrom && darkFrom > at ? `from about ${spokenTime(roundTo5(darkFrom), offset)}` : "now";
    parts.push(`Tonight in ${name} it's dark ${fromText}${darkUntil ? ` until about ${spokenTime(roundTo5(darkUntil), offset)}` : ""}.`);
    parts.push(needEyes < 0.5
      ? `${name} sits under the auroral oval, so even modest activity can light up the sky.`
      : `You'd need activity around Kp ${needEyes.toFixed(1)} to see it by eye, or ${needCamera.toFixed(1)} for a phone camera.`);
    if (peak) {
      const storm = stormWord(peak.kp_expected);
      parts.push(`The forecast peaks at about Kp ${peak.kp_expected.toFixed(1)}${storm ? `, ${storm},` : ""} around ${peak.local_time}${peak.kp_source === "noaa" ? ", according to NOAA's outlook" : ""}.`);
    }
    if (window && window.enough_for !== "neither") {
      const cloudText = window.cloud_cover_pct == null ? "" : window.cloud_cover_pct < 30 ? ", with mostly clear skies" : window.cloud_cover_pct < 70 ? `, with some cloud, about ${window.cloud_cover_pct} percent` : `, but clouds may cover about ${window.cloud_cover_pct} percent of the sky, so you'll need a gap`;
      parts.push(`Your best window is ${window.from_local} to ${window.to_local}${cloudText}. ${window.enough_for === "eyes" ? "That should be enough to see it by eye." : "Bring your phone: a night-mode photo is more likely than a naked-eye view."}`);
    } else {
      parts.push("That's not enough for a visible aurora, so it's probably a quiet night. I'll know more as the solar wind arrives.");
    }
  }

  return {
    place: describePlace(place, weather),
    speech: parts.join(" "),
    dark_from_local: darkFrom ? spokenTime(roundTo5(darkFrom), offset) : null,
    dark_until_local: darkUntil ? spokenTime(roundTo5(darkUntil), offset) : null,
    kp_needed_eyes: round(needEyes, 1),
    kp_needed_camera: round(needCamera, 1),
    best_window: window,
    hours,
  };
}

// ---------- the Sun right now ----------

export function spaceWeather(args: { nowcast: Nowcast; kp: KpBlock[]; at?: Date }): SpaceWeatherReport {
  const { nowcast: nc, kp } = args;
  const at = args.at ?? new Date();
  const w = nc.now;
  const median = quantileKp(w.exceed, nc.levels, 0.5);
  const p5 = probabilityAtLeast(w.exceed, nc.levels, 5);
  const p7 = probabilityAtLeast(w.exceed, nc.levels, 7);
  const future = kp.filter((b) => !b.observed && b.start.getTime() + 3 * 3600_000 > at.getTime());
  const within = (h: number) => future.filter((b) => b.start.getTime() < at.getTime() + h * 3600_000);
  const max = (bs: KpBlock[]) => (bs.length ? Math.max(...bs.map((b) => b.kp)) : null);
  const peakBlock = future.reduce<KpBlock | null>((p, b) => (b.kp > (p?.kp ?? -1) ? b : p), null);
  const minutesOld = Math.max(0, Math.round((at.getTime() - Date.parse(nc.generated)) / 60_000));

  const southward = w.bz < -5 ? "pointing strongly south, which is what drives the aurora" : w.bz < -1 ? "pointing slightly south" : w.bz > 1 ? "pointing north, which keeps the energy out" : "close to neutral";
  const pace = w.speed > 600 ? "fast" : w.speed > 450 ? "a little fast" : "calm";
  const parts = [
    `The solar wind is ${pace}: about ${Math.round(w.speed / 10) * 10} kilometres per second, with its magnetic field ${southward} at ${w.bz.toFixed(1)} nanotesla.`,
    `The next ${Math.round(w.ahead_minutes)} minutes of it are already measured on their way to Earth. For the next hour I expect activity around Kp ${median.toFixed(1)}, with ${spokenChance(p5)} of a minor storm or stronger.`,
  ];
  const max72 = max(within(72));
  if (peakBlock && max72 != null) {
    const day = peakBlock.start.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
    const storm = stormWord(max72);
    parts.push(`NOAA's three-day outlook peaks at Kp ${max72.toFixed(1)}${storm ? `, ${storm},` : ""} on ${day} around ${String(peakBlock.start.getUTCHours()).padStart(2, "0")}:00 UTC.`);
  }
  return {
    speech: parts.join(" "),
    solar_wind: { speed_km_s: Math.round(w.speed), density_cm3: round(w.density, 1), bz_nt: round(w.bz, 1), bz_min_on_its_way_nt: round(w.bz_min_ahead, 1), bt_nt: round(w.bt, 1), on_its_way_minutes: Math.round(w.ahead_minutes) },
    next_hour: { expected_kp: round(median, 1), chance_kp5_or_more: round(p5, 3), chance_kp7_or_more: round(p7, 3) },
    noaa: { max_kp_next_24h: max(within(24)), max_kp_next_72h: max72, peak_utc: peakBlock ? peakBlock.start.toISOString() : null },
    model: { run_at: nc.generated, minutes_old: minutesOld },
  };
}
