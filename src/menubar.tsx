import { Color, Icon, launchCommand, LaunchType, MenuBarExtra, open } from "@raycast/api";
import { useEffect, useState } from "react";
import { countAgents } from "./lib/agents";
import { gb, kb, mbOrGb, pressureColor, pressureLabel } from "./lib/format";
import { recordSwap } from "./lib/history";
import { log, timed } from "./lib/log";
import type { AppGroup, Memory } from "./lib/parse";
import { heavyApps, readMemory, readProcs, Tool } from "./lib/system";

const CMD = "menubar";

// Runs once a minute (manifest interval). Budget: one sysctl, one vm_stat, one ps, a directory listing,
// plus lsof / one sqlite count only while Codex / OpenCode are running.
interface Snapshot {
  memory: Memory;
  agents: Record<Tool, number>;
  agentKB: number;
  apps: AppGroup[];
}

async function snapshot(): Promise<Snapshot> {
  const [memory, procs] = await Promise.all([readMemory(), readProcs()]);
  await recordSwap(memory.swapUsedMB);
  const agents = await countAgents(procs);
  return {
    memory,
    agents,
    agentKB: procs.filter((p) => /(^|\/)(claude|codex)$/.test(p.comm)).reduce((s, p) => s + p.rssKB, 0),
    apps: heavyApps(procs).filter((a) => a.name !== "Claude Code").slice(0, 3),
  };
}

const total = (a: Record<Tool, number>) => a.claude + a.codex + a.opencode;

function title(s: Snapshot): string {
  const swap = `${(s.memory.swapUsedMB / 1024).toFixed(1)}G`;
  const swapHalfFull = s.memory.swapTotalMB > 0 && s.memory.swapUsedMB / s.memory.swapTotalMB > 0.5;
  if (s.memory.pressure === "normal" && !swapHalfFull) return `${total(s.agents)} ✳`;
  return `${swap} swap · ${total(s.agents)} ✳`;
}

export default function Command() {
  const [snap, setSnap] = useState<Snapshot>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    timed(CMD, "snapshot", snapshot, 1500)
      .then(setSnap)
      .catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);

  const openMain = async () => {
    try {
      await launchCommand({ name: "index", type: LaunchType.UserInitiated });
    } catch (e) {
      log(CMD, "launchCommand failed, falling back to deep link", e);
      await open("tinycast://extensions/rodrigoalegria/tinycast-headroom/index");
    }
  };

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
  const a = snap.agents;
  return (
    <MenuBarExtra icon={{ source: Icon.CircleFilled, tintColor: pressureColor[m.pressure] }} title={title(snap)} tooltip={`Memory pressure: ${pressureLabel[m.pressure]}`}>
      <MenuBarExtra.Section title="Memory Pressure">
        <MenuBarExtra.Item icon={{ source: Icon.CircleFilled, tintColor: pressureColor[m.pressure] }} title={pressureLabel[m.pressure]} />
        <MenuBarExtra.Item title="Swap" subtitle={`${gb(m.swapUsedMB)} of ${gb(m.swapTotalMB)} · ${pct}%`} />
        <MenuBarExtra.Item title="Compressed" subtitle={mbOrGb(m.compressedMB)} />
        <MenuBarExtra.Item title="Free" subtitle={mbOrGb(m.freeMB)} />
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="Agent Sessions">
        <MenuBarExtra.Item title={`${a.claude} Claude · ${a.codex} Codex · ${a.opencode} OpenCode`} subtitle={kb(snap.agentKB)} onAction={openMain} />
      </MenuBarExtra.Section>
      {snap.apps.length > 0 && (
        <MenuBarExtra.Section title="Biggest Apps">
          {snap.apps.map((app) => (
            <MenuBarExtra.Item key={app.name} title={app.name} subtitle={kb(app.rssKB)} onAction={openMain} />
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
