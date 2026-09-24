import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  getPreferenceValues,
  Icon,
  Image,
  List,
  open,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { existsSync } from "fs";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanAgents } from "./lib/agents";
import { compareBars, memoryPanel } from "./lib/charts";
import { latestClaudeVersion, linearUrl, showSession, versionLag } from "./lib/focus";
import { KeepListForm } from "./keep-list-form";
import { ReapView } from "./reap-view";
import { ago, clock, duration, gb, kb, mbOrGb, pressureColor, pressureLabel } from "./lib/format";
import { Point, PressureState, recordPressure, recordSwap } from "./lib/history";
import { LOG_FILE, log, timed } from "./lib/log";
import type { AppGroup, Memory } from "./lib/parse";
import {
  addToKeepList,
  heavyApps,
  quitApp,
  readIdle,
  readMemory,
  readProcs,
  reap,
  ReapResult,
  SCREEN_RECORDING_SETTINGS,
  ScreenRecordingPermissionError,
  Session,
  SessionState,
  takeScreenshot,
  tilde,
  Tool,
} from "./lib/system";

interface Preferences {
  reapPath?: string;
  idleThreshold?: string;
  linearWorkspace?: string;
}

const CMD = "index";

// Refresh cadence. Memory is two tiny commands; sessions and apps share one `ps`; the reap dry run is the slowest.
const MEMORY_MS = 5_000;
const SESSIONS_MS = 15_000;
const REAP_MS = 60_000;

const stateTag: Record<SessionState, { text: string; color: Color }> = {
  reapable: { text: "Reapable", color: Color.Red },
  working: { text: "Working", color: Color.Green },
  waiting: { text: "Waiting for you", color: Color.Orange },
  kept: { text: "Kept", color: Color.Blue },
};

const sectionTitle: Record<SessionState, string> = {
  reapable: "Reapable",
  working: "Working",
  waiting: "Waiting for You",
  kept: "Kept (keep list)",
};

const toolInfo: Record<Tool, { label: string; color: Color; app?: string; fallback: Image.ImageLike }> = {
  claude: { label: "Claude", color: Color.Orange, app: "/Applications/Claude.app", fallback: { source: Icon.Stars, tintColor: Color.Orange } },
  codex: { label: "Codex", color: Color.Blue, app: "/Applications/Codex.app", fallback: "codex.svg" },
  opencode: { label: "OpenCode", color: Color.Purple, app: "/Applications/OpenCode.app", fallback: { source: Icon.Terminal, tintColor: Color.Purple } },
};

// The real app icon when the app is installed; checked once, since every existsSync crosses the bridge.
const iconCache = new Map<Tool, Image.ImageLike>();
function toolIcon(tool: Tool): Image.ImageLike {
  let icon = iconCache.get(tool);
  if (!icon) {
    const info = toolInfo[tool];
    icon = info.app && existsSync(info.app) ? { fileIcon: info.app } : info.fallback;
    iconCache.set(tool, icon);
  }
  return icon;
}

function appIcon(app: AppGroup): Image.ImageLike {
  if (app.name === "Claude Code") return toolIcon("claude");
  return app.bundlePath ? { fileIcon: app.bundlePath } : Icon.AppWindow;
}

// Tinycast shrinks a row's accessory before its title, so titles are cut early to keep the
// accessory (wait time, state icon) readable in the narrow list column.
const LIST_TITLE_MAX = 16;
const listTitle = (t: string) => (t.length > LIST_TITLE_MAX ? `${t.slice(0, LIST_TITLE_MAX - 1).trimEnd()}…` : t);

/** "8m", "3h", "16d": fits the narrow list column Tinycast leaves next to the detail panel. */
function short(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** "a moment", "8 min", "3 h", "1 day", "16 days" */
function spoken(seconds: number): string {
  if (seconds < 60) return "a moment";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  const d = Math.floor(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

const gb1 = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Runs `task` now and every `ms`, skipping a tick while the previous run is still going. */
function usePoll(task: () => Promise<void>, ms: number, deps: unknown[]) {
  const busy = useRef(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (busy.current || !alive) return;
      busy.current = true;
      try {
        await task();
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const reapPath = prefs.reapPath?.trim() || "~/bin/claude-reap";
  const idleSpec = prefs.idleThreshold || "2d";

  const [memory, setMemory] = useState<Memory>();
  const [history, setHistory] = useState<Point[]>([]);
  const [pressureState, setPressureState] = useState<PressureState>();
  const { push } = useNavigation();
  const linearWorkspace = prefs.linearWorkspace?.trim() || "linkthings";
  const [scanned, setScanned] = useState<Session[]>();
  const [scanErrors, setScanErrors] = useState<Partial<Record<Tool, string>>>({});
  const [agentKB, setAgentKB] = useState(0);
  const [apps, setApps] = useState<AppGroup[]>([]);
  const [dryRun, setDryRun] = useState<ReapResult>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [epoch, setEpoch] = useState(0); // bump to force every loop to refresh now
  const dryRunRef = useRef<ReapResult | undefined>(undefined);

  const setError = useCallback((source: string, message?: string) => {
    setErrors((current) => {
      if (current[source] === message) return current;
      const next = { ...current };
      if (message) next[source] = message;
      else delete next[source];
      return next;
    });
  }, []);

  useEffect(() => log(CMD, "opened"), []);

  usePoll(
    async () => {
      try {
        const m = await timed(CMD, "memory", readMemory, 1000);
        setMemory(m);
        setPressureState(await recordPressure(m.pressure));
        setHistory(await recordSwap(m.swapUsedMB));
        setError("Memory");
      } catch (e) {
        setError("Memory", errorText(e));
      }
    },
    MEMORY_MS,
    [epoch],
  );

  usePoll(
    async () => {
      try {
        const r = await timed(CMD, "claude-reap dry run", () => reap(reapPath, idleSpec, false), 3000);
        dryRunRef.current = r;
        setDryRun(r);
        setError("claude-reap");
      } catch (e) {
        setError("claude-reap", `${errorText(e)} (path: ${reapPath})`);
      }
    },
    REAP_MS,
    [epoch, reapPath, idleSpec],
  );

  // Independent of the reap dry run: reapable state is applied at render time, so a dry run
  // finishing never restarts (or skips) this loop.
  usePoll(
    async () => {
      try {
        const [procs, idle] = await timed(CMD, "ps + w", () => Promise.all([readProcs(), readIdle()]), 1000);
        setAgentKB(procs.filter((p) => /(^|\/)(claude|codex)$/.test(p.comm)).reduce((s, p) => s + p.rssKB, 0));
        setApps(heavyApps(procs));
        // Two passes: sessions show as soon as they're read; repo, branch and changes (git) fill in after.
        const fast = await scanAgents(CMD, procs, idle, false);
        setScanned((current) => (current ? mergeRepos(fast.sessions, current) : fast.sessions));
        setScanErrors(fast.errors);
        const full = await scanAgents(CMD, procs, idle, true);
        setScanned(full.sessions);
        setScanErrors(full.errors);
        setError("Sessions");
      } catch (e) {
        setError("Sessions", errorText(e));
        setScanned((current) => current ?? []);
      }
    },
    SESSIONS_MS,
    [epoch],
  );

  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  const sessions = useMemo(() => {
    const reapable = new Set((dryRun?.victims ?? []).filter((v) => v.kind === "session").map((v) => v.pid));
    return scanned?.map((s) => (s.tool === "claude" && s.pid && reapable.has(s.pid) ? { ...s, state: "reapable" as const } : s));
  }, [scanned, dryRun]);

  const reapPids = useCallback(
    async (pids: number[]) => {
      const victims = (dryRunRef.current?.victims ?? []).filter((v) => pids.includes(v.pid));
      if (!victims.length) {
        await showToast({ style: Toast.Style.Failure, title: "Nothing to reap", message: "It is no longer idle past the threshold." });
        return;
      }
      push(
        <ReapView
          victims={victims}
          keptCount={dryRunRef.current?.kept.length ?? 0}
          reapPath={reapPath}
          idleSpec={idleSpec}
          apps={apps}
          onFinished={refresh}
        />,
      );
    },
    [reapPath, idleSpec, refresh, push, apps],
  );

  const quit = useCallback(
    async (app: AppGroup) => {
      const ok = await confirmAlert({
        title: `Quit ${app.name}?`,
        message: `Frees about ${kb(app.rssKB)}. The app is asked to quit normally, so it can save first.`,
        primaryAction: { title: "Quit", style: Alert.ActionStyle.Destructive },
      });
      if (!ok) return;
      try {
        await quitApp(app.name);
        log(CMD, `asked ${app.name} to quit`);
        await showToast({ style: Toast.Style.Success, title: `Asked ${app.name} to quit` });
      } catch (e) {
        log(CMD, `quit ${app.name} failed`, e);
        await showToast({ style: Toast.Style.Failure, title: `Could not quit ${app.name}`, message: errorText(e) });
      }
      refresh();
    },
    [refresh],
  );

  const screenshot = useCallback(async () => {
    try {
      const path = await takeScreenshot(1);
      log(CMD, `screenshot saved to ${path}`);
      await showToast({ style: Toast.Style.Success, title: "Screenshot saved", message: tilde(path) });
    } catch (e) {
      log(CMD, "screenshot failed", e);
      if (e instanceof ScreenRecordingPermissionError) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Tinycast can't record the screen",
          message: "Allow it in Privacy & Security → Screen & System Audio Recording, then reopen Tinycast.",
          primaryAction: { title: "Open Screen Recording Settings", onAction: () => open(SCREEN_RECORDING_SETTINGS) },
        });
        await open(SCREEN_RECORDING_SETTINGS);
      } else {
        await showToast({ style: Toast.Style.Failure, title: "Screenshot failed", message: errorText(e) });
      }
    }
  }, []);

  const victims = dryRun?.victims ?? [];
  const reapAllKB = victims.reduce((s, v) => s + v.rssKB, 0);
  const shells = victims.filter((v) => v.kind === "shell");

  const commonActions = (
    <>
      <Action title="Refresh" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={refresh} />
      {victims.length > 0 && (
        <Action
          title={`Reap ${victims.length} Idle (${kb(reapAllKB)})…`}
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
          onAction={() => reapPids(victims.map((v) => v.pid))}
        />
      )}
      <Action
        title="Edit Keep List…"
        icon={Icon.Lock}
        shortcut={{ modifiers: ["cmd", "shift"], key: "k" }}
        onAction={() => push(<KeepListForm sessions={sessions ?? []} onSaved={refresh} />)}
      />
      <Action title="Take Screenshot" icon={Icon.Camera} shortcut={{ modifiers: ["cmd", "shift"], key: "s" }} onAction={screenshot} />
      <Action.ShowInFinder title="Show Log File" path={LOG_FILE} shortcut={{ modifiers: ["cmd", "shift"], key: "l" }} />
    </>
  );

  // The session whose terminal read input most recently, within the last 2 minutes. Sessions can
  // read their terminal while working too, so this is "typed in most recently", not proof of focus.
  const inUseKey = (sessions ?? [])
    .filter((x) => x.lastInputAt !== undefined && Date.now() - x.lastInputAt < 120_000)
    .sort((a, b) => (b.lastInputAt ?? 0) - (a.lastInputAt ?? 0))[0]?.key;
  const latestClaude = latestClaudeVersion();
  const allClear = !!memory && memory.pressure === "normal" && (memory.swapTotalMB === 0 || memory.swapUsedMB / memory.swapTotalMB < 0.5) && victims.length === 0;

  const allErrors = { ...errors, ...Object.fromEntries(Object.entries(scanErrors).map(([t, m]) => [toolInfo[t as Tool].label, m])) };
  const groups: SessionState[] = ["reapable", "working", "waiting", "kept"];
  const counts = (["claude", "codex", "opencode"] as Tool[])
    .map((t) => [t, (sessions ?? []).filter((s) => s.tool === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${toolInfo[t].label}`)
    .join(" · ");
  const agentsLine = sessions ? `${sessions.length} running${counts ? ` (${counts})` : ""} · ${gb1(agentKB / 1024)}` : "loading…";

  return (
    <List isShowingDetail isLoading={!memory || !sessions} searchBarPlaceholder="Filter by name, topic, tool, repo, branch or ticket…">
      {Object.entries(allErrors).map(([source, message]) => (
        <List.Item
          key={`error-${source}`}
          id={`error-${source}`}
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title={`${source} failed`}
          subtitle={message}
          detail={<List.Item.Detail markdown={`**${source} failed**\n\n\`\`\`\n${message}\n\`\`\`\n\nDetails are in the log file (⌘⇧L).`} />}
          actions={
            <ActionPanel>
              <Action title="Retry" icon={Icon.ArrowClockwise} onAction={refresh} />
              <Action.ShowInFinder title="Show Log File" path={LOG_FILE} />
            </ActionPanel>
          }
        />
      ))}
      {memory && (
        <List.Section title="Right Now">
          <List.Item
            id="pressure"
            icon={allClear ? { source: Icon.CheckCircle, tintColor: Color.Green } : { source: Icon.CircleFilled, tintColor: pressureColor[memory.pressure] }}
            title={allClear ? "All clear" : `Pressure: ${pressureLabel[memory.pressure]}`}
            detail={
              allClear ? (
                <AllClearDetail memory={memory} history={history} pressure={pressureState} sessions={sessions?.length ?? 0} idleSpec={idleSpec} />
              ) : (
                <MemoryDetail memory={memory} history={history} pressure={pressureState} agentsLine={agentsLine} />
              )
            }
            actions={<ActionPanel>{commonActions}</ActionPanel>}
          />
        </List.Section>
      )}
      {groups.map((g) => {
        const items = (sessions ?? []).filter((s) => s.state === g);
        if (!items.length) return null;
        return (
          <List.Section key={g} title={`${sectionTitle[g]} · ${items.length}`}>
            {items.map((s) => (
              <SessionItem
                key={s.key}
                session={s}
                inUse={s.key === inUseKey}
                latestClaude={latestClaude}
                linearWorkspace={linearWorkspace}
                onReap={() => s.pid && reapPids([s.pid])}
                commonActions={commonActions}
                onChanged={refresh}
              />
            ))}
          </List.Section>
        );
      })}
      {shells.length > 0 && (
        <List.Section title="Idle Shells">
          <List.Item
            id="shells"
            icon={{ fileIcon: "/System/Applications/Utilities/Terminal.app" }}
            title={`${shells.length} idle shell${shells.length === 1 ? "" : "s"} · ${gb1(shells.reduce((s, v) => s + v.rssKB, 0) / 1024)}`}
            detail={
              <List.Item.Detail
                markdown={`**Idle login shells**\n\nTerminal tabs with nothing running, idle past ${idleSpec}.\n\n${shells
                  .map((v) => `- \`${v.tty}\` idle ${duration(v.idleSeconds)}: ${tilde(v.cwd)}`)
                  .join("\n")}`}
              />
            }
            actions={
              <ActionPanel>
                <Action title="Reap Idle Shells…" icon={Icon.Trash} style={Action.Style.Destructive} onAction={() => reapPids(shells.map((v) => v.pid))} />
                {commonActions}
              </ActionPanel>
            }
          />
        </List.Section>
      )}
      {apps.length > 0 && (
        <List.Section title="Heavy Apps">
          {apps.slice(0, 12).map((a) => (
            <List.Item
              key={a.name}
              id={`app-${a.name}`}
              icon={appIcon(a)}
              title={listTitle(a.name)}
              accessories={[{ text: gb1(a.rssKB / 1024) }]}
              detail={<AppDetail app={a} memory={memory} reapKB={reapAllKB} agentKB={agentKB} />}
              actions={
                <ActionPanel>
                  {a.quittable && <Action title="Quit App…" icon={Icon.XMarkCircle} style={Action.Style.Destructive} onAction={() => quit(a)} />}
                  {commonActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}

/** Keeps repo details from the last full pass so rows don't flicker while git runs again. */
function mergeRepos(fresh: Session[], previous: Session[]): Session[] {
  const byKey = new Map(previous.map((s) => [s.key, s]));
  return fresh.map((s) => {
    const old = byKey.get(s.key);
    return old && !s.repo ? { ...s, repo: old.repo, otherRepos: old.otherRepos, workspace: s.workspace ?? old.workspace, ticket: s.ticket ?? old.ticket } : s;
  });
}

function sinceLine(p: PressureState | undefined, level: string): string {
  if (!p || p.level !== level) return "";
  return p.observed ? ` since ${clock(p.since)}` : ` · seen since ${clock(p.since)}`;
}

function MemoryDetail({ memory, history, pressure, agentsLine }: { memory: Memory; history: Point[]; pressure?: PressureState; agentsLine?: string }) {
  const points = history.slice(-60);
  const markdown = [
    `## ${pressureLabel[memory.pressure]}${sinceLine(pressure, memory.pressure)}`,
    memory.pressure === "normal"
      ? "Plenty of headroom."
      : "macOS is compressing memory and swapping to disk. Switching apps will feel slow. kernel_task and WindowServer running hot is a symptom of this, not the cause.",
    `![Swap and memory](${memoryPanel(memory, points)})`,
    points.length < 2 ? "_The swap chart fills in as samples come in, one a minute while Headroom is open._" : "",
    agentsLine ? `**Agent sessions:** ${agentsLine}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return <List.Item.Detail markdown={markdown} />;
}

function AllClearDetail({
  memory,
  history,
  pressure,
  sessions,
  idleSpec,
}: {
  memory: Memory;
  history: Point[];
  pressure?: PressureState;
  sessions: number;
  idleSpec: string;
}) {
  const markdown = [
    `## Plenty of headroom`,
    `Pressure is normal${sinceLine(pressure, memory.pressure)}, swap is under half full and nothing is idle past ${idleSpec}. ${sessions} agent session${sessions === 1 ? "" : "s"} running.`,
    `![Swap and memory](${memoryPanel(memory, history.slice(-60))})`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return <List.Item.Detail markdown={markdown} />;
}

function SessionItem({
  session: s,
  inUse,
  latestClaude,
  linearWorkspace,
  onReap,
  commonActions,
  onChanged,
}: {
  session: Session;
  inUse: boolean;
  latestClaude?: string;
  linearWorkspace: string;
  onReap: () => void;
  commonActions: ReactNode;
  onChanged: () => void;
}) {
  const tool = toolInfo[s.tool];
  const lag = s.tool === "claude" ? versionLag(s.version, latestClaude) : undefined;
  const waitingFor = s.statusSince ? (Date.now() - s.statusSince) / 1000 : undefined;
  const accessory = inUse
    ? { icon: { source: Icon.Keyboard, tintColor: Color.Blue }, tooltip: "Typed in most recently" }
    : s.state === "reapable"
      ? { text: { value: short(s.idleSeconds), color: Color.Red }, tooltip: "Idle past the threshold" }
      : s.state === "waiting"
        ? { text: { value: short(waitingFor), color: Color.Orange }, tooltip: "Waiting for you" }
        : s.state === "working"
          ? { icon: { source: Icon.CircleFilled, tintColor: Color.Green }, tooltip: "Working" }
          : { icon: { source: Icon.Lock, tintColor: Color.Blue }, tooltip: "On the keep list" };

  const minutes = (sec: number | undefined) => (sec === undefined ? "" : ` for ${spoken(sec)}`);
  const stateLine =
    s.state === "reapable"
      ? `**Idle**${minutes(s.idleSeconds)}, past the reap threshold`
      : s.state === "waiting"
        ? `**Waiting for you**${minutes(waitingFor)}`
        : s.state === "working"
          ? "**Working** right now"
          : "**Kept** · on the keep list";
  const code = (t: string) => `\`${t.replace(/`/g, "'")}\``;
  const repo = s.repo;
  const where = repo
    ? [
        `**${repo.name}**${repo.worktree ? ` · worktree ${code(repo.worktree)}` : ""}`,
        [repo.branch ? code(repo.branch) : "", s.ticket ? `**${s.ticket}**` : "", repo.changes ? `${repo.changes} uncommitted` : "clean"].filter(Boolean).join(" · "),
        ...s.otherRepos.map((r) => `Also touched **${r.name}**${r.branch ? ` on ${code(r.branch)}` : ""}`),
      ]
    : [`Not in a git repo · ran from ${code(tilde(s.cwd))}`];
  const lines = [
    `## ${s.title}`,
    `${stateLine} · ${tool.label} in ${s.origin}${inUse ? " · typed in most recently" : ""}`,
    lag ? `⚠️ Running an old Claude Code, **${lag}**. Restart this session to update it.` : "",
    s.topic && s.topic !== s.title ? `> ${s.topic}` : "",
    "#### Latest",
    s.lastPrompt ? `**You:** ${s.lastPrompt}` : "",
    s.lastReply ? `**${tool.label}:** ${s.lastReply}` : "",
    `_${clock(s.lastMessageAt)} · ${ago(s.lastMessageAt)}_`,
    "#### Where",
    ...where,
    "#### Session",
    [
      code(s.name),
      s.pid !== undefined ? `PID ${s.pid}` : "",
      s.rssKB !== undefined ? kb(s.rssKB) : "",
      s.startedAt ? `started ${clock(s.startedAt)}` : "",
      s.model ?? "",
      s.version ? `v${s.version}${lag ? " (old)" : ""}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  ];
  const markdown = lines.filter(Boolean).join("\n\n");

  return (
    <List.Item
      id={s.key}
      icon={toolIcon(s.tool)}
      title={listTitle(s.title)}
      keywords={[s.title, tool.label, s.name, s.topic, s.repo?.name, s.repo?.branch, s.ticket, s.cwd, s.workspace, s.origin].filter((x): x is string => !!x)}
      accessories={[accessory]}
      detail={<List.Item.Detail markdown={markdown} />}
      actions={
        <ActionPanel>
          {(s.pid !== undefined || s.origin === "OpenCode Desktop") && (
            <Action
              title="Show Session"
              icon={Icon.Window}
              onAction={async () => {
                const toast = await showToast({ style: Toast.Style.Animated, title: "Finding its window…" });
                try {
                  toast.title = await showSession(s);
                  toast.style = Toast.Style.Success;
                } catch (e) {
                  log(CMD, `show session ${s.key} failed`, e);
                  toast.style = Toast.Style.Failure;
                  toast.title = "Couldn't show this session";
                  toast.message = errorText(e);
                }
              }}
            />
          )}
          {s.ticket && (
            <Action.OpenInBrowser title={`Open ${s.ticket} in Linear`} url={linearUrl(linearWorkspace, s.ticket)} shortcut={{ modifiers: ["cmd"], key: "l" }} />
          )}
          {s.resumeCommand && <Action.CopyToClipboard title="Copy Resume Command" content={s.resumeCommand} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />}
          {s.repo?.branch && <Action.CopyToClipboard title="Copy Branch Name" content={s.repo.branch} shortcut={{ modifiers: ["cmd"], key: "b" }} />}
          {s.ticket && <Action.CopyToClipboard title={`Copy ${s.ticket}`} content={s.ticket} shortcut={{ modifiers: ["cmd"], key: "t" }} />}
          <Action.ShowInFinder title="Show Folder in Finder" path={s.repo?.root ?? s.cwd} />
          {s.tool === "claude" && s.state !== "kept" && (
            <Action
              title="Keep This Folder"
              icon={Icon.Lock}
              onAction={async () => {
                addToKeepList(s.cwd);
                await showToast({ style: Toast.Style.Success, title: "Added to keep list", message: tilde(s.cwd) });
                onChanged();
              }}
            />
          )}
          {s.state === "reapable" && (
            <Action title="Reap This Session…" icon={Icon.Trash} style={Action.Style.Destructive} shortcut={{ modifiers: ["ctrl"], key: "x" }} onAction={onReap} />
          )}
          {commonActions}
        </ActionPanel>
      }
    />
  );
}

function AppDetail({ app, memory, reapKB, agentKB }: { app: AppGroup; memory?: Memory; reapKB: number; agentKB: number }) {
  const mb = app.rssKB / 1024;
  const share = memory ? Math.round((mb / memory.totalMB) * 100) : undefined;
  const bars = compareBars(
    [
      { label: app.name, mb, color: "#0E7C86" },
      { label: "Reapable now", mb: reapKB / 1024, color: "#D2453B" },
      { label: "All agents", mb: agentKB / 1024, color: "#D48A10" },
    ],
    memory ? memory.totalMB / 4 : mb,
  );
  const ratio = reapKB > 0 ? app.rssKB / reapKB : 0;
  const markdown = [
    `## ${app.name}`,
    `**${kb(app.rssKB)}**${share !== undefined ? ` · ${share}% of RAM` : ""} · ${app.processes} process${app.processes === 1 ? "" : "es"}`,
    `![Compared](${bars})`,
    ratio >= 2
      ? `Quitting ${app.name} frees about **${Math.round(ratio)}×** more than reaping every idle session.`
      : reapKB === 0
        ? "Nothing is reapable right now, so quitting an app is the only way to free this much."
        : "",
    app.quittable ? "Quit asks the app to close normally, so it can save first." : "Not an app bundle, so Headroom can't ask it to quit.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return <List.Item.Detail markdown={markdown} />;
}
