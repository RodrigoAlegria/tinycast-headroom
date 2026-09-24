import { Action, ActionPanel, Detail, Icon, useNavigation } from "@raycast/api";
import { CopyAction } from "./copy-action";
import { ReactNode, useState } from "react";
import { gb, kb } from "./lib/format";
import { log } from "./lib/log";
import type { AppGroup } from "./lib/parse";
import { reap, ReapResult, ReapVictim, tilde } from "./lib/system";

type Phase = { step: "confirm" } | { step: "reaping" } | { step: "done"; result: ReapResult } | { step: "failed"; message: string };

function idle(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  const d = Math.floor(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

const cell = (t: string) => t.replace(/\|/g, "\\|");

function victimTable(victims: ReapVictim[], status?: (v: ReapVictim) => string): string {
  const head = `| | PID | Terminal | Idle | Memory | Folder |${status ? " Result |" : ""}\n|---|---|---|---|---|---|${status ? "---|" : ""}`;
  const rows = victims.map(
    (v) =>
      `| ${v.kind === "session" ? "Claude" : "Shell"} | ${v.pid} | ${v.tty} | ${idle(v.idleSeconds)} | ${kb(v.rssKB)} | ${cell(tilde(v.cwd))} |${status ? ` ${status(v)} |` : ""}`,
  );
  return [head, ...rows].join("\n");
}

/**
 * The reap flow as pages: the dry run with the count first, then reaping, then what changed.
 * Nothing is signalled until the person presses the Reap action on the first page.
 */
export function ReapView(props: {
  victims: ReapVictim[];
  keptCount: number;
  reapPath: string;
  idleSpec: string;
  apps: AppGroup[];
  onFinished: () => void;
  /** Closing one chosen session that isn't idle: says so plainly and offers its resume command. */
  close?: { title: string; state: string; resumeCommand?: string };
}) {
  const { pop } = useNavigation();
  const [phase, setPhase] = useState<Phase>({ step: "confirm" });
  const { victims } = props;
  const totalKB = victims.reduce((s, v) => s + v.rssKB, 0);
  const noun = `process${victims.length === 1 ? "" : "es"}`;
  const bigApps = props.apps.filter((a) => a.name !== "Claude Code").slice(0, 2);

  const go = async () => {
    setPhase({ step: "reaping" });
    try {
      const result = await reap(props.reapPath, props.idleSpec, true, victims.map((v) => v.pid), !!props.close);
      log("index", `reaped ${result.victims.map((v) => v.pid).join(",")} freed ${result.reclaimKB} KB`);
      setPhase({ step: "done", result });
    } catch (e) {
      log("index", "reap failed", e);
      setPhase({ step: "failed", message: e instanceof Error ? e.message : String(e) });
    }
    props.onFinished();
  };

  let markdown: string;
  let actions: ReactNode;
  if (phase.step === "confirm" && props.close) {
    const c = props.close;
    markdown = [
      `## Close “${c.title}”?`,
      `This session is **${c.state}**, not idle. Closing it ends the conversation in its terminal. You can pick it up again later with its resume command.`,
      victimTable(victims),
      c.resumeCommand ? `**Resume later:** \`${c.resumeCommand.replace(/`/g, "'")}\`` : "",
      "Nothing is closed until you press **↵**.",
    ]
      .filter(Boolean)
      .join("\n\n");
    actions = (
      <ActionPanel>
        <Action title="Close Session" icon={Icon.Trash} style={Action.Style.Destructive} onAction={go} />
        {c.resumeCommand && <CopyAction title="Copy Resume Command First" content={c.resumeCommand} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />}
        <Action title="Cancel" icon={Icon.XMarkCircle} onAction={pop} />
      </ActionPanel>
    );
  } else if (phase.step === "confirm") {
    markdown = [
      `## ${victims.length} ${noun} · ${kb(totalKB)}`,
      `Idle longer than **${props.idleSpec}**. Your keep list${props.keptCount ? ` (${props.keptCount} skipped)` : ""} and newer sessions are left alone.`,
      victimTable(victims),
      "Nothing is closed until you press **↵**. Each one gets SIGHUP, then SIGKILL after 2 seconds if it's still running.",
    ].join("\n\n");
    actions = (
      <ActionPanel>
        <Action title={`Reap ${victims.length} ${noun[0].toUpperCase()}${noun.slice(1)}`} icon={Icon.Trash} style={Action.Style.Destructive} onAction={go} />
        <Action title="Cancel" icon={Icon.XMarkCircle} shortcut={{ modifiers: [], key: "escape" }} onAction={pop} />
      </ActionPanel>
    );
  } else if (phase.step === "reaping") {
    markdown = [`## Reaping ${victims.length} ${noun}…`, "Sent SIGHUP. Waiting 2 seconds for them to exit, then SIGKILL for any still running.", victimTable(victims, () => "closing…")].join("\n\n");
    actions = <ActionPanel />;
  } else if (phase.step === "done") {
    const r = phase.result;
    const reaped = new Set(r.victims.map((v) => v.pid));
    const stragglers = new Set(r.stragglers);
    const skipped = victims.filter((v) => !reaped.has(v.pid));
    const after = r.after;
    markdown = [
      `## Reaped ${r.victims.length} · freed ~${kb(r.reclaimKB)}`,
      victimTable(victims, (v) => (!reaped.has(v.pid) ? "skipped, no longer idle" : stragglers.has(v.pid) ? "killed (ignored SIGHUP)" : "closed")),
      after
        ? `| | Before | After |\n|---|---|---|\n| Swap | ${gb(r.before.swapUsedMB)} | ${gb(after.swapUsedMB)} |\n| Free | ${Math.round(r.before.freeMB)} MB | ${Math.round(after.freeMB)} MB |\n| Compressed | ${gb(r.before.compressorMB)} | ${gb(after.compressorMB)} |`
        : "",
      skipped.length ? `${skipped.length} ${skipped.length === 1 ? "was" : "were"} skipped because ${skipped.length === 1 ? "it was" : "they were"} used again after the dry run.` : "",
      `This buys some swap headroom, but open apps take freed memory back within minutes.${
        bigApps.length ? ` Closing one heavy app frees far more: ${bigApps.map((a) => `**${a.name}** ${kb(a.rssKB)}`).join(", ")}.` : ""
      }`,
    ]
      .filter(Boolean)
      .join("\n\n");
    actions = (
      <ActionPanel>
        <Action title="Done" icon={Icon.Check} onAction={pop} />
      </ActionPanel>
    );
  } else {
    markdown = [`## Reap failed`, "```\n" + phase.message + "\n```", "Nothing may have been closed. Details are in the log file."].join("\n\n");
    actions = (
      <ActionPanel>
        <Action title="Back" icon={Icon.ArrowLeft} onAction={pop} />
      </ActionPanel>
    );
  }

  return <Detail isLoading={phase.step === "reaping"} navigationTitle={props.close ? "Close Session" : "Reap Idle Processes"} markdown={markdown} actions={actions} />;
}
