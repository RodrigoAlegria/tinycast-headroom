import type { Memory, Pressure } from "./parse";

type Point = [minute: number, swapMB: number];

// SVG images for the detail panel's markdown. Tinycast renders data-URI images, and the
// neutral greys read on both its light and dark themes.
const TEXT = "#8a8f98";
const TRACK = "#8a8f9833";
const FONT = "-apple-system,BlinkMacSystemFont,Helvetica,sans-serif";
const MONO = "Menlo,monospace";

export const pressureHex: Record<Pressure, string> = { normal: "#2E9B5F", warning: "#D48A10", critical: "#D2453B" };
const WIRED = "#7B8894";
const APPS = "#0E7C86";
const COMPRESSED = "#D48A10";

const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const gbText = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/**
 * Swap gauge ring, memory composition bar and, when there are samples, the swap chart below,
 * all in one image: Tinycast rendered only the first of two images in a detail panel.
 */
export function memoryPanel(m: Memory, history: Point[] = [], width = 460): string {
  const chartH = 90;
  const hasChart = history.length >= 2;
  const height = hasChart ? 116 + 28 + chartH : 116;
  const pct = m.swapTotalMB > 0 ? Math.min(1, m.swapUsedMB / m.swapTotalMB) : 0;
  const r = 38;
  const c = 2 * Math.PI * r;
  const color = pressureHex[m.pressure];
  const cx = 52;
  const cy = 54;

  // wired + compressed + apps/cache + free = installed
  const total = Math.max(m.totalMB, 1);
  const apps = Math.max(0, total - m.wiredMB - m.compressedMB - m.freeMB);
  const parts = [
    { label: "Wired", mb: m.wiredMB, color: WIRED },
    { label: "Apps", mb: apps, color: APPS },
    { label: "Compressed", mb: m.compressedMB, color: COMPRESSED },
  ];
  const barX = 128;
  const barW = width - barX - 8;
  let x = barX;
  const segs = parts
    .map((p) => {
      const w = (p.mb / total) * barW;
      const s = `<rect x="${x.toFixed(1)}" y="40" width="${Math.max(0, w).toFixed(1)}" height="14" fill="${p.color}"/>`;
      x += w;
      return s;
    })
    .join("");
  const legend = parts
    .map((p, i) => {
      const lx = barX + i * (barW / 3);
      return `<circle cx="${lx + 5}" cy="76" r="4" fill="${p.color}"/><text x="${lx + 14}" y="80" font-family="${FONT}" font-size="11" fill="${TEXT}">${p.label} ${gbText(p.mb)}</text>`;
    })
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="10"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(pct * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>` +
    `<text x="${cx}" y="${cy + 2}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="${color}">${Math.round(pct * 100)}%</text>` +
    `<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${TEXT}">swap</text>` +
    `<text x="${barX}" y="28" font-family="${FONT}" font-size="12" fill="${TEXT}">Memory · ${gbText(total)} installed · ${gbText(m.freeMB)} free</text>` +
    `<rect x="${barX}" y="40" width="${barW}" height="14" rx="4" fill="${TRACK}"/>` +
    segs +
    legend +
    `<text x="${barX}" y="104" font-family="${FONT}" font-size="11" fill="${TEXT}">Swap ${gbText(m.swapUsedMB)} of ${gbText(m.swapTotalMB)}</text>` +
    (hasChart ? sparkBody(history, m.swapTotalMB, 0, 116 + 28, width, chartH) : "") +
    `</svg>`;
  return uri(svg);
}

/** Horizontal bars comparing a few values on one scale, e.g. an app against all reapable sessions. */
export function compareBars(rows: Array<{ label: string; mb: number; color: string }>, scaleMB: number, width = 460): string {
  const rowH = 30;
  const height = rows.length * rowH + 8;
  const labelW = 120;
  const valueW = 70;
  const barW = width - labelW - valueW - 8;
  const top = Math.max(scaleMB, ...rows.map((r) => r.mb), 1);
  const body = rows
    .map((r, i) => {
      const y = i * rowH + 8;
      const w = Math.max(2, (r.mb / top) * barW);
      return (
        `<text x="0" y="${y + 13}" font-family="${FONT}" font-size="12" fill="${TEXT}">${esc(r.label)}</text>` +
        `<rect x="${labelW}" y="${y + 3}" width="${barW}" height="12" rx="4" fill="${TRACK}"/>` +
        `<rect x="${labelW}" y="${y + 3}" width="${w.toFixed(1)}" height="12" rx="4" fill="${r.color}"/>` +
        `<text x="${width}" y="${y + 13}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${TEXT}">${gbText(r.mb)}</text>`
      );
    })
    .join("");
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`);
}

/** Swap-used line chart as SVG elements, drawn inside a box at (ox, oy). Empty when under 2 samples. */
function sparkBody(points: Point[], totalMB: number, ox: number, oy: number, width: number, height: number): string {
  if (points.length < 2) return "";
  const top = Math.max(totalMB, ...points.map((p) => p[1]), 1);
  const first = points[0][0];
  const span = Math.max(points[points.length - 1][0] - first, 1);
  const x = (m: number) => ox + ((m - first) / span) * (width - 8) + 4;
  const y = (v: number) => oy + height - 14 - (v / top) * (height - 26);
  const line = points.map(([m, v], i) => `${i ? "L" : "M"}${x(m).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const [lm, lv] = points[points.length - 1];
  const hhmm = (m: number) => {
    const d = new Date(m * 60000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return (
    `<text x="${ox}" y="${oy - 6}" font-family="${FONT}" font-size="12" fill="${TEXT}">Swap used since ${hhmm(first)}</text>` +
    `<line x1="${ox}" y1="${y(top)}" x2="${ox + width}" y2="${y(top)}" stroke="${TEXT}" stroke-dasharray="3 4" stroke-opacity=".5"/>` +
    `<line x1="${ox}" y1="${y(0)}" x2="${ox + width}" y2="${y(0)}" stroke="${TEXT}" stroke-opacity=".5"/>` +
    `<path d="${line} L${x(lm).toFixed(1)} ${y(0)} L${ox + 4} ${y(0)} Z" fill="#D48A10" fill-opacity=".18"/>` +
    `<path d="${line}" fill="none" stroke="#D48A10" stroke-width="2"/>` +
    `<circle cx="${x(lm).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="3.5" fill="#D48A10"/>` +
    `<text x="${ox + width - 2}" y="${y(top) - 3}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${TEXT}">${gbText(top)}</text>` +
    `<text x="${ox + 2}" y="${oy + height - 2}" font-family="${MONO}" font-size="10" fill="${TEXT}">${hhmm(first)}</text>` +
    `<text x="${ox + width - 2}" y="${oy + height - 2}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${TEXT}">${gbText(lv)} now</text>`
  );
}

/** Standalone swap chart (kept for callers that want only the line). */
export function sparkline(points: Point[], totalMB: number, width = 360, height = 90): string | undefined {
  if (points.length < 2) return undefined;
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 16}" viewBox="0 0 ${width} ${height + 16}">${sparkBody(points, totalMB, 0, 16, width, height)}</svg>`);
}
