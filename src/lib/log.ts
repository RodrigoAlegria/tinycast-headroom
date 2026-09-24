import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Tinycast doesn't surface extension errors anywhere, so Headroom keeps its own log.
export const SUPPORT_DIR = join(homedir(), "Library/Application Support/com.tinycast.app/extension-support/tinycast-headroom");
export const LOG_FILE = join(SUPPORT_DIR, "headroom.log");
const MAX_BYTES = 512 * 1024;

let ready = false;

export function log(command: string, message: string, error?: unknown) {
  try {
    if (!ready) {
      mkdirSync(SUPPORT_DIR, { recursive: true });
      ready = true;
    }
    const detail = error instanceof Error ? ` | ${error.message}${error.stack ? `\n${error.stack}` : ""}` : error !== undefined ? ` | ${String(error)}` : "";
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${command}] ${message}${detail}\n`);
    if (statSync(LOG_FILE).size > MAX_BYTES) {
      const text = readFileSync(LOG_FILE, "utf8");
      writeFileSync(LOG_FILE, text.slice(text.indexOf("\n", text.length / 2) + 1));
    }
  } catch {
    // logging must never break the extension
  }
}

/** Runs `task`, logging how long it took when slow, and any failure with its stack. */
export async function timed<T>(command: string, label: string, task: () => Promise<T>, slowMs = 1500): Promise<T> {
  const started = Date.now();
  try {
    const result = await task();
    const ms = Date.now() - started;
    if (ms >= slowMs) log(command, `${label} slow: ${ms} ms`);
    return result;
  } catch (e) {
    log(command, `${label} failed after ${Date.now() - started} ms`, e);
    throw e;
  }
}
