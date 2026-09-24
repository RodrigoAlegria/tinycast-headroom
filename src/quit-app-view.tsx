import { Action, ActionPanel, Detail, Icon, useNavigation } from "@raycast/api";
import { ReactNode, useState } from "react";
import { kb } from "./lib/format";
import { log } from "./lib/log";
import type { AppGroup } from "./lib/parse";
import { quitApp } from "./lib/system";

type Phase = "confirm" | "quitting" | "done" | "failed";

/**
 * Confirms inside Tinycast. A native alert (confirmAlert) takes focus from Tinycast's window,
 * and Tinycast hides the window when it loses focus, so the confirm step closed Headroom.
 */
export function QuitAppView({ app, onFinished }: { app: AppGroup; onFinished: () => void }) {
  const { pop } = useNavigation();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [error, setError] = useState("");

  const go = async () => {
    setPhase("quitting");
    try {
      await quitApp(app.name);
      log("index", `asked ${app.name} to quit`);
      setPhase("done");
    } catch (e) {
      log("index", `quit ${app.name} failed`, e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
    onFinished();
  };

  let markdown: string;
  let actions: ReactNode;
  if (phase === "confirm") {
    markdown = `## Quit ${app.name}?\n\nFrees about **${kb(app.rssKB)}** (${app.processes} process${app.processes === 1 ? "" : "es"}).\n\nThe app is asked to quit normally, so it can save first. If it has unsaved work it may ask you, in its own window.\n\nPress **↵** to quit it.`;
    actions = (
      <ActionPanel>
        <Action title={`Quit ${app.name}`} icon={Icon.XMarkCircle} style={Action.Style.Destructive} onAction={go} />
        <Action title="Cancel" icon={Icon.ArrowLeft} onAction={pop} />
      </ActionPanel>
    );
  } else if (phase === "quitting") {
    markdown = `## Quitting ${app.name}…`;
    actions = <ActionPanel />;
  } else if (phase === "done") {
    markdown = `## Asked ${app.name} to quit\n\nAbout **${kb(app.rssKB)}** should come back within a few seconds. If it's still listed after the next refresh, it's waiting on you in its own window.`;
    actions = (
      <ActionPanel>
        <Action title="Done" icon={Icon.Check} onAction={pop} />
      </ActionPanel>
    );
  } else {
    markdown = `## Couldn't quit ${app.name}\n\n\`\`\`\n${error}\n\`\`\``;
    actions = (
      <ActionPanel>
        <Action title="Back" icon={Icon.ArrowLeft} onAction={pop} />
      </ActionPanel>
    );
  }
  return <Detail isLoading={phase === "quitting"} navigationTitle={`Quit ${app.name}`} markdown={markdown} actions={actions} />;
}
