import { Color, Icon, launchCommand, LaunchType, MenuBarExtra, open } from "@raycast/api";
import { useEffect, useState } from "react";
import { gb, kb, mbOrGb, pressureColor, pressureLabel } from "./lib/format";
import { recordSwap } from "./lib/history";
import type { AppGroup, Memory } from "./lib/parse";
import { heavyApps, readMemory, readProcs, readStatusFiles } from "./lib/system";

// Runs once a minute (manifest interval). Budget: one sysctl, one vm_stat, one ps, one directory listing.
interface Snapshot {
  memory: Memory;
  sessions: number;
  claudeKB: number;
  apps: AppGroup[];
}

async function snapshot(): Promise<Snapshot> {
  const [memory, procs] = await Promise.all([readMemory(), readProcs()]);
  await recordSwap(memory.swapUsedMB);
  const claude = procs.filter((p) => /(^|\/)claude$/.test(p.comm));
  const sessions = readStatusFiles(new Set(claude.map((p) => p.pid))).length;
  return {
    memory,
    sessions,
    claudeKB: claude.reduce((s, p) => s + p.rssKB, 0),
    apps: heavyApps(procs).filter((a) => a.name !== "Claude Code").slice(0, 3),
  };
}

function title(s: Snapshot): string {
  const swap = `${(s.memory.swapUsedMB / 1024).toFixed(1)}G`;
  const swapHalfFull = s.memory.swapTotalMB > 0 && s.memory.swapUsedMB / s.memory.swapTotalMB > 0.5;
  if (s.memory.pressure === "normal" && !swapHalfFull) return `${s.sessions} ✳`;
  return `${swap} swap · ${s.sessions} ✳`;
}

export default function Command() {
  const [snap, setSnap] = useState<Snapshot>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    snapshot()
      .then(setSnap)
      .catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);

  const openMain = () => launchCommand({ name: "index", type: LaunchType.UserInitiated });

  if (!snap) {
    return (
      <MenuBarExtra isLoading={!failed} icon={{ source: Icon.CircleFilled, tintColor: Color.SecondaryText }} title={failed ? "Headroom !" : undefined}>
        {failed && <MenuBarExtra.Item title={`Failed: ${failed}`} />}
        <MenuBarExtra.Item title="Open Headroom" onAction={openMain} />
      </MenuBarExtra>
    );
  }

  const m = snap.memory;
  const pct = m.swapTotalMB ? Math.round((m.swapUsedMB / m.swapTotalMB) * 100) : 0;
  return (
    <MenuBarExtra icon={{ source: Icon.CircleFilled, tintColor: pressureColor[m.pressure] }} title={title(snap)} tooltip={`Memory pressure: ${pressureLabel[m.pressure]}`}>
      <MenuBarExtra.Section title="Memory Pressure">
        <MenuBarExtra.Item icon={{ source: Icon.CircleFilled, tintColor: pressureColor[m.pressure] }} title={pressureLabel[m.pressure]} />
        <MenuBarExtra.Item title="Swap" subtitle={`${gb(m.swapUsedMB)} of ${gb(m.swapTotalMB)} · ${pct}%`} />
        <MenuBarExtra.Item title="Compressed" subtitle={mbOrGb(m.compressedMB)} />
        <MenuBarExtra.Item title="Free" subtitle={mbOrGb(m.freeMB)} />
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="Claude Code">
        <MenuBarExtra.Item title={`${snap.sessions} sessions`} subtitle={kb(snap.claudeKB)} onAction={openMain} />
      </MenuBarExtra.Section>
      {snap.apps.length > 0 && (
        <MenuBarExtra.Section title="Biggest Apps">
          {snap.apps.map((a) => (
            <MenuBarExtra.Item key={a.name} title={a.name} subtitle={kb(a.rssKB)} onAction={openMain} />
          ))}
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Open Headroom" icon={Icon.Gauge} shortcut={{ modifiers: ["cmd"], key: "o" }} onAction={openMain} />
        <MenuBarExtra.Item title="Activity Monitor" icon={Icon.AppWindow} onAction={() => open("/System/Applications/Utilities/Activity Monitor.app")} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
