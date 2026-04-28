import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Structured per-invocation tool log. Written as JSONL to TOOL_LOG_PATH so
 * it's easy to grep / aggregate later ("which tools are people actually
 * using? which fail? which take too long?"). Off by default — set the env
 * var to enable.
 *
 * The log includes full call args because the deployment writes to a local
 * data directory that doesn't leave the host. If that ever changes, scrub
 * args before persisting.
 */

export interface ToolLogEntry {
  ts: string;
  user_id?: string;
  user_name?: string;
  tool: string;
  args: unknown;
  duration_ms: number;
  ok: boolean;
  error?: string;
}

const LOG_PATH = process.env.TOOL_LOG_PATH;
let dirEnsured = false;

async function ensureDir(path: string): Promise<void> {
  if (dirEnsured) return;
  await mkdir(dirname(path), { recursive: true });
  dirEnsured = true;
}

export function isToolLoggingEnabled(): boolean {
  return !!LOG_PATH;
}

export async function logToolInvocation(entry: ToolLogEntry): Promise<void> {
  if (!LOG_PATH) return;
  try {
    await ensureDir(LOG_PATH);
    await appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    // Logging failures must never bubble up to the user — just surface them
    // in the console so an operator can spot a misconfigured path.
    console.error(`[tool-logger] failed to write to ${LOG_PATH}:`, err);
  }
}
