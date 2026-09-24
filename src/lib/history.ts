import { LocalStorage } from "@raycast/api";

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
