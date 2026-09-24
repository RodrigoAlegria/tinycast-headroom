import { Color } from "@raycast/api";
import type { Pressure } from "./parse";
import type { Point } from "./history";

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

/** Swap-used sparkline as an SVG data URI, for the detail panel's markdown. */
export function sparkline(points: Point[], totalMB: number, width = 360, height = 90): string | undefined {
  if (points.length < 2) return undefined;
  const top = Math.max(totalMB, ...points.map((p) => p[1]), 1);
  const first = points[0][0];
  const span = Math.max(points[points.length - 1][0] - first, 1);
  const x = (m: number) => ((m - first) / span) * (width - 8) + 4;
  const y = (v: number) => height - 14 - (v / top) * (height - 26);
  const line = points.map(([m, v], i) => `${i ? "L" : "M"}${x(m).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const [lm, lv] = points[points.length - 1];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<line x1="0" y1="${y(top)}" x2="${width}" y2="${y(top)}" stroke="#888" stroke-dasharray="3 4" stroke-opacity=".4"/>` +
    `<line x1="0" y1="${y(0)}" x2="${width}" y2="${y(0)}" stroke="#888" stroke-opacity=".4"/>` +
    `<path d="${line} L${x(lm).toFixed(1)} ${y(0)} L4 ${y(0)} Z" fill="#D48A10" fill-opacity=".18"/>` +
    `<path d="${line}" fill="none" stroke="#D48A10" stroke-width="2"/>` +
    `<circle cx="${x(lm).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="3.5" fill="#D48A10"/>` +
    `<text x="${width - 2}" y="${y(top) - 3}" text-anchor="end" font-family="Menlo,monospace" font-size="10" fill="#888">${gb(top)}</text>` +
    `<text x="2" y="${height - 2}" font-family="Menlo,monospace" font-size="10" fill="#888">${clock(first * 60000)}</text>` +
    `<text x="${width - 2}" y="${height - 2}" text-anchor="end" font-family="Menlo,monospace" font-size="10" fill="#888">${gb(lv)} now</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
