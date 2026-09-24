import { Action, ActionPanel, Form, Icon, showToast, Toast, useNavigation } from "@raycast/api";
import { useState } from "react";
import { log } from "./lib/log";
import { globMatch, parseKeepList } from "./lib/parse";
import { KEEP_FILE, readKeepFile, Session, tilde, writeKeepFile } from "./lib/system";

/** Edits ~/.config/claude-reap/keep, the same file claude-reap reads, so both tools agree. */
export function KeepListForm({ sessions, onSaved }: { sessions: Session[]; onSaved: () => void }) {
  const { pop } = useNavigation();
  const [text, setText] = useState(() => readKeepFile());
  const globs = parseKeepList(text);
  const claude = sessions.filter((s) => s.tool === "claude");
  const protectedNow = claude.filter((s) => globs.some((g) => globMatch(g, s.cwd)));

  return (
    <Form
      navigationTitle="Keep List"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Save Keep List"
            icon={Icon.Check}
            onSubmit={async () => {
              try {
                writeKeepFile(text);
                log("index", `keep list saved: ${globs.length} pattern(s)`);
                await showToast({ style: Toast.Style.Success, title: "Keep list saved", message: `${globs.length} pattern${globs.length === 1 ? "" : "s"}` });
                onSaved();
                pop();
              } catch (e) {
                await showToast({ style: Toast.Style.Failure, title: "Could not save the keep list", message: e instanceof Error ? e.message : String(e) });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Keep list"
        text={`Sessions whose folder matches a line here are never reaped. One glob per line, # for comments. * matches anything, including /. Saved to ${tilde(KEEP_FILE)}.`}
      />
      <Form.TextArea id="globs" title="Patterns" value={text} onChange={setText} placeholder={"*/my-project\n*/clients/*/archive"} />
      <Form.Description
        title="Protects now"
        text={protectedNow.length ? protectedNow.map((s) => `${s.title} (${tilde(s.cwd)})`).join("\n") : "No running Claude session matches these patterns."}
      />
    </Form>
  );
}
