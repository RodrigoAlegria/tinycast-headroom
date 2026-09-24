// Pure parsers for macOS command output. No I/O here, so every one is unit-tested.

export type Pressure = "normal" | "warning" | "critical";

export interface Memory {
  pressure: Pressure;
  totalMB: number;
  freeMB: number;
  wiredMB: number;
  compressedMB: number;
  swapUsedMB: number;
  swapTotalMB: number;
}

/** kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
export function parsePressure(level: string): Pressure {
  const n = parseInt(level.trim(), 10);
  if (n >= 4) return "critical";
  if (n === 2) return "warning";
  return "normal";
}

/** "total = 5120.00M  used = 3648.12M  free = 1471.88M  (encrypted)" */
export function parseSwap(text: string): { usedMB: number; totalMB: number } {
  const num = (key: string) => {
    const m = text.match(new RegExp(`${key} = ([\\d.]+)([MG])`));
    if (!m) return 0;
    return parseFloat(m[1]) * (m[2] === "G" ? 1024 : 1);
  };
  return { usedMB: num("used"), totalMB: num("total") };
}

/** vm_stat output → MB figures, using the page size from its header line. */
export function parseVmStat(text: string): { freeMB: number; wiredMB: number; compressedMB: number } {
  const pageSize = parseInt(text.match(/page size of (\d+) bytes/)?.[1] ?? "16384", 10);
  const pages = (label: string) => {
    const m = text.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? parseInt(m[1], 10) : 0;
  };
  const mb = (n: number) => (n * pageSize) / 1048576;
  return {
    freeMB: mb(pages("Pages free")),
    wiredMB: mb(pages("Pages wired down")),
    compressedMB: mb(pages("Pages occupied by compressor")),
  };
}

/** One `sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage hw.memsize` call, plus vm_stat. */
export function parseMemory(sysctlOut: string, vmStatOut: string): Memory {
  const [level = "1", swapLine = "", memsize = "0"] = sysctlOut.trim().split("\n");
  const swap = parseSwap(swapLine);
  return {
    pressure: parsePressure(level),
    totalMB: parseInt(memsize, 10) / 1048576,
    ...parseVmStat(vmStatOut),
    swapUsedMB: swap.usedMB,
    swapTotalMB: swap.totalMB,
  };
}

/** `w` idle column: "-", "53" (minutes), "2:41" (h:mm), "1day", "9days". Returns seconds. */
export function parseIdle(idle: string): number {
  if (!idle || idle === "-") return 0;
  let m = idle.match(/^(\d+)days?$/);
  if (m) return parseInt(m[1], 10) * 86400;
  m = idle.match(/^(\d+):(\d+)$/);
  if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
  m = idle.match(/^(\d+)$/);
  if (m) return parseInt(m[1], 10) * 60;
  return 0;
}

/** `w -h` → tty ("s005") → idle seconds. */
export function parseW(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5) map.set(cols[1], parseIdle(cols[4]));
  }
  return map;
}

export interface Proc {
  pid: number;
  rssKB: number;
  tty: string; // normalised to `w` form: "s005", or "" when there is none
  etime: string;
  comm: string;
}

/** `ps -axo pid=,rss=,tty=,etime=,comm=` (comm last because it can contain spaces). */
export function parsePs(text: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const tty = m[3] === "??" ? "" : m[3].replace(/^tty/, "");
    procs.push({ pid: +m[1], rssKB: +m[2], tty, etime: m[4], comm: m[5].trim() });
  }
  return procs;
}

/** ps etime "[[dd-]hh:]mm:ss" → seconds. */
export function parseEtime(etime: string): number {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + +m[3] * 60 + +m[4];
}

export interface AppGroup {
  name: string;
  rssKB: number;
  processes: number;
  quittable: boolean; // a real .app we can ask to quit
  bundlePath?: string; // outermost .app, for its icon
}

/** Groups processes by their outermost .app bundle, so helpers count toward their app. */
export function groupApps(procs: Proc[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const p of procs) {
    let name: string;
    let quittable = false;
    let bundlePath: string | undefined;
    const app = p.comm.match(/^(.*?\/([^/]+)\.app)(?:\/|$)/);
    if (app) {
      name = app[2];
      bundlePath = app[1];
      quittable = !p.comm.startsWith("/System/");
    } else if (/(^|\/)claude$/.test(p.comm)) {
      name = "Claude Code";
    } else {
      name = p.comm.split("/").pop() || p.comm;
    }
    const g = groups.get(name) ?? { name, rssKB: 0, processes: 0, quittable, bundlePath };
    g.rssKB += p.rssKB;
    g.processes += 1;
    g.quittable = g.quittable || quittable;
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.rssKB - a.rssKB);
}

/** Ticket id from a branch name: "fix/ABC-123_login-redirect" → "ABC-123". */
export function ticketFromBranch(branch: string | undefined): string | undefined {
  const m = branch?.match(/(?:^|[/_-])([A-Za-z]{2,6}\d?-\d{1,6})(?=$|[_/-])/);
  return m ? m[1].toUpperCase() : undefined;
}

/** Where a folder lives: an Orca workspace, a git worktree under .worktrees, or a plain folder. */
export function describeWorkspace(dir: string): string | undefined {
  let m = dir.match(/\/orca\/workspaces\/([^/]+)\/([^/]+)/);
  if (m) return `Orca · ${m[1]} / ${m[2]}`;
  m = dir.match(/\/\.worktrees\/([^/]+)/);
  if (m) return `Worktree · ${m[1]}`;
  return undefined;
}

/** claude-reap keep-list glob (bash [[ == ]] style: * matches anything, including /). */
export function globMatch(glob: string, path: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(path);
}

export function parseKeepList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Threshold spec "30m" / "12h" / "2d" → seconds (same rules as claude-reap). */
export function thresholdSeconds(spec: string): number {
  const m = spec.match(/^(\d+)([mhd]?)$/);
  if (!m) return 172800;
  const n = parseInt(m[1], 10);
  return m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : m[2] === "d" ? n * 86400 : n;
}
