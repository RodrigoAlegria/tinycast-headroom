# Headroom

A Tinycast extension for a 16 GB Mac that keeps running out of memory. It shows memory pressure and swap, every running agent session (Claude Code, Codex and OpenCode) (what it's about, its repo, branch and ticket, when you last talked to it), and the heaviest apps. Idle sessions can be reaped through [`claude-reap`](#claude-reap), always with a dry run and a confirm first.

## Commands

- **Headroom**: memory pressure, swap history, Claude sessions grouped as Reapable / Working / Waiting for you / Kept, idle shells, heavy apps with Quit.
- **Headroom Menu Bar**: swap and session count in the menu bar, refreshed once a minute.

## Performance budget

Headroom exists because the machine is short on memory, so it must not add to the problem.

- Target: under 10 MB added to Tinycast, under 0.5% CPU.
- The menu bar command runs one `sysctl`, one `vm_stat`, one `ps` and a directory listing per minute.
- Sessions, git and the reap dry run only run while the Headroom window is open (every 15 s, 15 s and 60 s).
- Transcripts can be 60 MB+. Only the first and last 64 KB are read, and the result is cached until the file size changes.
- `ps` uses `comm=` (~70 KB) rather than full command lines (~180 KB).
- No `nettop`, `system_profiler` or `ioreg`, and no binary command output: Tinycast's UTF-8 decoder throws on invalid bytes.

## Where the data comes from

| Shows | Source |
| --- | --- |
| Pressure | `sysctl kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical) |
| Swap | `sysctl vm.swapusage` |
| Free / wired / compressed | `vm_stat` |
| Processes, app memory | `ps -axo pid=,rss=,tty=,etime=,comm=` |
| Terminal idle time | `w -h` |
| Session name, working / waiting | `~/.claude/sessions/<pid>.json` |
| Topic, last prompt, last message | `~/.claude/projects/*/<sessionId>.jsonl` (two 64 KB windows) |
| Repo, branch, uncommitted | folders of files the session edited → `git rev-parse`, `git status --branch` |
| Codex sessions | rollout files a `codex` process has open (`lsof -c codex`), so terminal, Orca and desktop sessions all show |
| OpenCode sessions | `~/.local/share/opencode/opencode.db`, read-only, sessions touched in the last 24 h while OpenCode runs |
| Reapable | `claude-reap --json` dry run (Claude sessions and idle shells only) |

## Troubleshooting

Headroom writes errors and slow operations to
`~/Library/Application Support/com.tinycast.app/extension-support/tinycast-headroom/headroom.log`
(⌘⇧L in the window opens it in Finder).

**Take Screenshot fails**: Tinycast needs Screen Recording permission. System Settings → Privacy & Security →
Screen & System Audio Recording → turn on Tinycast (add it with + if it's missing), then quit and reopen Tinycast.

## claude-reap

Reaping is delegated to `~/bin/claude-reap` (path configurable), which needs `--json` and `--only`:

```sh
claude-reap --json                       # dry run, machine-readable
claude-reap --json --apply --only 44887  # reap only confirmed PIDs, re-checked first
```

Headroom never sends signals itself. It always passes the exact PIDs you confirmed, and claude-reap re-checks each one is still idle before sending SIGHUP (then SIGKILL).

## Build and install

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run install-local
```

Restart Tinycast after the first install, then search for **Headroom**, or open `tinycast://extensions/rodrigoalegria/tinycast-headroom/index`.
