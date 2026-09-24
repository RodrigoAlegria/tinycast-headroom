import { LocalStorage } from "@raycast/api";
import { nextPressureState, PressureState } from "./pressure";

export type { PressureState } from "./pressure";

// One [epoch-minute, swapUsedMB] pair per minute while the window is open, 24 h max: ~20 KB at most.
const KEY = "swap-history-v1";
const MAX_POINTS = 1440;

export type Point = [minute: number, swapMB: number];

export async function loadHistory(): Promise<Point[]> {
  try {
    const raw = await LocalStorage.getItem<string>(KEY);
    return raw ? (JSON.parse(raw) as Point[]) : [];
  } catch {
    return [];
  }
}

/** Adds a sample unless this minute already has one. Returns the updated series. */
export async function recordSwap(swapMB: number, now = Date.now()): Promise<Point[]> {
  const points = await loadHistory();
  const minute = Math.floor(now / 60000);
  if (points.length && points[points.length - 1][0] === minute) return points;
  points.push([minute, Math.round(swapMB)]);
  const trimmed = points.filter(([m]) => m > minute - MAX_POINTS).slice(-MAX_POINTS);
  try {
    await LocalStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // storage unavailable: the chart just stays short
  }
  return trimmed;
}

// ---------- pressure level changes ----------
// When the current level started. Only trusted when Headroom was watching without a gap:
// after more than 5 minutes unwatched, a change could have been missed, so `observed` is false
// and the page says "seen since" instead of claiming when it began.
const PRESSURE_KEY = "pressure-state-v2";

let lastPressure: PressureState | undefined;

export async function recordPressure(level: string, now = Date.now()): Promise<PressureState> {
  if (!lastPressure) {
    try {
      const raw = await LocalStorage.getItem<string>(PRESSURE_KEY);
      lastPressure = raw ? (JSON.parse(raw) as PressureState) : undefined;
    } catch {
      lastPressure = undefined;
    }
  }
  const next = nextPressureState(lastPressure, level, now);
  const changed = !lastPressure || next.level !== lastPressure.level || next.since !== lastPressure.since;
  lastPressure = next;
  // Persist on changes, otherwise only in the first 5 s of each minute (one 5 s poll), to keep writes rare.
  if (changed || now % 60000 < 5000) {
    try {
      await LocalStorage.setItem(PRESSURE_KEY, JSON.stringify(next));
    } catch {
      // not persisted: the page still knows for this session
    }
  }
  return next;
}
