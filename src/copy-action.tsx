import { Action, Clipboard, Icon, Keyboard, showToast, Toast } from "@raycast/api";

/**
 * Copies without closing Tinycast. The built-in Action.CopyToClipboard closes the window after
 * copying (Raycast's default, which Tinycast follows); Headroom should stay open.
 */
export function CopyAction({ title, content, shortcut }: { title: string; content: string; shortcut?: Keyboard.Shortcut }) {
  return (
    <Action
      title={title}
      icon={Icon.Clipboard}
      shortcut={shortcut}
      onAction={async () => {
        await Clipboard.copy(content);
        await showToast({ style: Toast.Style.Success, title: "Copied", message: content.length > 60 ? `${content.slice(0, 59)}…` : content });
      }}
    />
  );
}
