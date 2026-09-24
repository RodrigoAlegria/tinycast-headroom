import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  getPreferenceValues,
  Icon,
  List,
  open,
  showToast,
  Toast,
} from "@raycast/api";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanAgents } from "./lib/agents";
import { ago, clock, duration, gb, kb, mbOrGb, pressureColor, pressureLabel, sparkline } from "./lib/format";
import { Point, recordSwap } from "./lib/history";
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

const toolInfo: Record<Tool, { label: string; color: Color }> = {
  claude: { label: "Claude", color: Color.Orange },
  codex: { label: "Codex", color: Color.Blue },
  opencode: { label: "OpenCode", color: Color.Purple },
};

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
      const totalKB = victims.reduce((s, v) => s + v.rssKB, 0);
      const ok = await confirmAlert({
        title: `Reap ${victims.length} process${victims.length === 1 ? "" : "es"} · ${kb(totalKB)}?`,
        message: victims
          .slice(0, 8)
          .map((v) => `${v.kind === "session" ? "Claude" : "Shell"} ${v.tty}, idle ${duration(v.idleSeconds)}: ${tilde(v.cwd)}`)
          .join("\n"),
        primaryAction: { title: "Reap", style: Alert.ActionStyle.Destructive },
      });
      if (!ok) return;
      const toast = await showToast({ style: Toast.Style.Animated, title: `Reaping ${victims.length}…` });
      try {
        const r = await reap(reapPath, idleSpec, true, victims.map((v) => v.pid));
        log(CMD, `reaped ${r.victims.map((v) => v.pid).join(",")} freed ${r.reclaimKB} KB`);
        toast.style = Toast.Style.Success;
        toast.title = `Reaped ${r.victims.length} · freed ~${kb(r.reclaimKB)}`;
        toast.message = r.after ? `Swap ${gb(r.before.swapUsedMB)} → ${gb(r.after.swapUsedMB)}` : undefined;
      } catch (e) {
        log(CMD, "reap failed", e);
        toast.style = Toast.Style.Failure;
        toast.title = "Reap failed";
        toast.message = errorText(e);
      }
      refresh();
    },
    [reapPath, idleSpec, refresh],
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
      <Action title="Take Screenshot" icon={Icon.Camera} shortcut={{ modifiers: ["cmd", "shift"], key: "s" }} onAction={screenshot} />
      <Action.ShowInFinder title="Show Log File" path={LOG_FILE} shortcut={{ modifiers: ["cmd", "shift"], key: "l" }} />
    </>
  );

  const allErrors = { ...errors, ...Object.fromEntries(Object.entries(scanErrors).map(([t, m]) => [toolInfo[t as Tool].label, m])) };
  const groups: SessionState[] = ["reapable", "working", "waiting", "kept"];
  const counts = (["claude", "codex", "opencode"] as Tool[])
    .map((t) => [t, (sessions ?? []).filter((s) => s.tool === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${toolInfo[t].label}`)
    .join(" · ");

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
            icon={{ source: Icon.CircleFilled, tintColor: pressureColor[memory.pressure] }}
            title="Memory pressure"
            accessories={[{ text: { value: pressureLabel[memory.pressure], color: pressureColor[memory.pressure] } }]}
            detail={<MemoryDetail memory={memory} history={history} />}
            actions={<ActionPanel>{commonActions}</ActionPanel>}
          />
          <List.Item
            id="swap"
            icon={Icon.HardDrive}
            title="Swap"
            subtitle={memory.swapTotalMB ? `${Math.round((memory.swapUsedMB / memory.swapTotalMB) * 100)}% full` : "none"}
            accessories={[{ text: gb(memory.swapUsedMB) }]}
            detail={<MemoryDetail memory={memory} history={history} />}
            actions={<ActionPanel>{commonActions}</ActionPanel>}
          />
          <List.Item
            id="agents"
            icon={Icon.Terminal}
            title="Agent sessions"
            subtitle={sessions ? counts || "none running" : "loading…"}
            accessories={[{ text: sessions ? kb(agentKB) : "…" }]}
            detail={<MemoryDetail memory={memory} history={history} />}
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
              <SessionItem key={s.key} session={s} onReap={() => s.pid && reapPids([s.pid])} commonActions={commonActions} onChanged={refresh} />
            ))}
          </List.Section>
        );
      })}
      {shells.length > 0 && (
        <List.Section title="Idle Shells">
          <List.Item
            id="shells"
            icon={Icon.Terminal}
            title={`${shells.length} idle shell${shells.length === 1 ? "" : "s"}`}
            accessories={[{ text: kb(shells.reduce((s, v) => s + v.rssKB, 0)) }]}
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
              icon={Icon.AppWindow}
              title={a.name}
              subtitle={a.processes > 1 ? `${a.processes} processes` : undefined}
              accessories={[{ text: kb(a.rssKB) }]}
              detail={<AppDetail app={a} memory={memory} reapKB={reapAllKB} />}
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

function MemoryDetail({ memory, history }: { memory: Memory; history: Point[] }) {
  const chart = sparkline(history.slice(-60), memory.swapTotalMB);
  const markdown = [
    `## ${pressureLabel[memory.pressure]}`,
    memory.pressure === "normal"
      ? "Plenty of headroom."
      : "macOS is compressing memory and swapping to disk. Switching apps will feel slow. kernel_task and WindowServer running hot is a symptom of this, not the cause.",
    chart ? `**Swap used, last hour**\n\n![Swap used](${chart})` : "_The swap chart fills in as samples come in, one a minute._",
  ].join("\n\n");
  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.TagList title="Pressure">
            <List.Item.Detail.Metadata.TagList.Item text={pressureLabel[memory.pressure]} color={pressureColor[memory.pressure]} />
          </List.Item.Detail.Metadata.TagList>
          <List.Item.Detail.Metadata.Label title="Swap" text={`${gb(memory.swapUsedMB)} of ${gb(memory.swapTotalMB)}`} />
          <List.Item.Detail.Metadata.Label title="Compressed" text={mbOrGb(memory.compressedMB)} />
          <List.Item.Detail.Metadata.Label title="Wired" text={mbOrGb(memory.wiredMB)} />
          <List.Item.Detail.Metadata.Label title="Free" text={mbOrGb(memory.freeMB)} />
          <List.Item.Detail.Metadata.Label title="Installed" text={gb(memory.totalMB)} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function SessionItem({
  session: s,
  onReap,
  commonActions,
  onChanged,
}: {
  session: Session;
  onReap: () => void;
  commonActions: ReactNode;
  onChanged: () => void;
}) {
  const tag = stateTag[s.state];
  const tool = toolInfo[s.tool];
  const stateAccessory =
    s.state === "reapable"
      ? { tag: { value: duration(s.idleSeconds), color: Color.Red } }
      : s.state === "waiting"
        ? { tag: { value: duration(s.statusSince ? (Date.now() - s.statusSince) / 1000 : undefined), color: Color.Orange } }
        : { tag: { value: tag.text, color: tag.color } };
  const subtitle = [s.ticket, s.topic].filter(Boolean).join(" · ");
  const since = s.statusSince ? ` since ${clock(s.statusSince)}` : "";

  return (
    <List.Item
      id={s.key}
      icon={{ source: Icon.Terminal, tintColor: tool.color }}
      title={s.name}
      subtitle={subtitle}
      keywords={[tool.label, s.topic, s.repo?.branch, s.ticket, s.cwd, s.workspace, s.origin].filter((x): x is string => !!x)}
      accessories={[{ tag: { value: tool.label, color: tool.color } }, stateAccessory]}
      detail={
        <List.Item.Detail
          markdown={`## ${s.name}\n\n${s.topic ? `_${s.topic}_` : "_No prompt yet_"}`}
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.TagList title="State">
                <List.Item.Detail.Metadata.TagList.Item text={`${tag.text}${s.state === "reapable" ? ` · idle ${duration(s.idleSeconds)}` : since}`} color={tag.color} />
              </List.Item.Detail.Metadata.TagList>
              <List.Item.Detail.Metadata.TagList title="Tool">
                <List.Item.Detail.Metadata.TagList.Item text={tool.label} color={tool.color} />
              </List.Item.Detail.Metadata.TagList>
              <List.Item.Detail.Metadata.Label title="Runs in" text={s.origin} />
              <List.Item.Detail.Metadata.Label title="Last message" text={`${clock(s.lastMessageAt)} · ${ago(s.lastMessageAt)}`} />
              {s.lastPrompt && <List.Item.Detail.Metadata.Label title="Last prompt" text={s.lastPrompt} />}
              <List.Item.Detail.Metadata.Separator />
              {s.workspace && <List.Item.Detail.Metadata.Label title="Workspace" text={s.workspace} />}
              <List.Item.Detail.Metadata.Label title="Repo" text={s.repo ? tilde(s.repo.root) : `none · ran from ${tilde(s.cwd)}`} />
              {s.repo?.branch && <List.Item.Detail.Metadata.Label title="Branch" text={s.repo.branch} />}
              {s.ticket && (
                <List.Item.Detail.Metadata.TagList title="Ticket">
                  <List.Item.Detail.Metadata.TagList.Item text={s.ticket} color={Color.Blue} />
                </List.Item.Detail.Metadata.TagList>
              )}
              {s.repo && <List.Item.Detail.Metadata.Label title="Uncommitted" text={s.repo.changes ? `${s.repo.changes} file${s.repo.changes === 1 ? "" : "s"}` : "none · clean"} />}
              {s.otherRepos.map((r) => (
                <List.Item.Detail.Metadata.Label key={r.root} title="Also touched" text={`${tilde(r.root)}${r.branch ? ` · ${r.branch}` : ""}`} />
              ))}
              <List.Item.Detail.Metadata.Separator />
              {s.pid !== undefined && <List.Item.Detail.Metadata.Label title="Process" text={`PID ${s.pid}${s.tty ? ` · ${s.tty}` : ""}`} />}
              <List.Item.Detail.Metadata.Label title="Started" text={clock(s.startedAt)} />
              {s.rssKB !== undefined && <List.Item.Detail.Metadata.Label title="Memory" text={kb(s.rssKB)} />}
              {s.model && <List.Item.Detail.Metadata.Label title="Model" text={s.model} />}
              {s.version && <List.Item.Detail.Metadata.Label title="Version" text={s.version} />}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          {s.resumeCommand && <Action.CopyToClipboard title="Copy Resume Command" content={s.resumeCommand} />}
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

function AppDetail({ app, memory, reapKB }: { app: AppGroup; memory?: Memory; reapKB: number }) {
  const share = memory ? Math.round((app.rssKB / 1024 / memory.totalMB) * 100) : undefined;
  return (
    <List.Item.Detail
      markdown={`## ${app.name}\n\n${
        reapKB && app.rssKB > reapKB * 2
          ? `Holds about ${Math.round(app.rssKB / Math.max(reapKB, 1))}× more than reaping every idle session would free.`
          : ""
      }`}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Memory" text={kb(app.rssKB)} />
          <List.Item.Detail.Metadata.Label title="Processes" text={String(app.processes)} />
          {share !== undefined && <List.Item.Detail.Metadata.Label title="Share of RAM" text={`${share}%`} />}
          <List.Item.Detail.Metadata.Label title="Quit" text={app.quittable ? "Available (asks first)" : "Not an app bundle"} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}
