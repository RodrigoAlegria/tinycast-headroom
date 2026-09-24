// Pure: kept apart from history.ts, which needs Tinycast's LocalStorage.
const MAX_GAP_MS = 5 * 60 * 1000;

export interface PressureState {
  level: string;
  since: number;
  observed: boolean;
  checkedAt: number;
}

export function nextPressureState(prev: PressureState | undefined, level: string, now: number): PressureState {
  if (!prev || now - prev.checkedAt > MAX_GAP_MS) return { level, since: now, observed: false, checkedAt: now };
  if (prev.level !== level) return { level, since: now, observed: true, checkedAt: now };
  return { ...prev, checkedAt: now };
}
