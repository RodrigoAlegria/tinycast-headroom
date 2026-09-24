import { Color } from "@raycast/api";
import type { Pressure } from "./parse";

export const gb = (mb: number) => `${(mb / 1024).toFixed(mb >= 10240 ? 1 : 2)} GB`;
export const mbOrGb = (mb: number) => (mb >= 1024 ? gb(mb) : `${Math.round(mb)} MB`);
export const kb = (kb: number) => mbOrGb(kb / 1024);

export function ago(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "unknown";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return "–";
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

export function clock(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "–";
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === d.toDateString()) return `${time} today`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

export const pressureColor: Record<Pressure, Color> = {
  normal: Color.Green,
  warning: Color.Orange,
  critical: Color.Red,
};

export const pressureLabel: Record<Pressure, string> = {
  normal: "Normal",
  warning: "Warning",
  critical: "Critical",
};
