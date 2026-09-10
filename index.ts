/**
 * Pi Git Syncher — pi extension entry point.
 *
 * Wires the syncer engine (syncer.ts) into the pi session:
 * - starts the poll loop on session_start, stops it on session_shutdown
 * - registers /git-sync (toggle) and /git-sync status
 *
 * The loop is a chained setTimeout, so ticks never overlap and the poll
 * interval always follows the current config file.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  CONFIG_FILE,
  createSyncer,
  loadConfig,
  type Syncer,
  type SyncerStatus,
} from "./syncer.ts";

const FALLBACK_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const GIT_TIMEOUT_MS = 120_000;

export default function (pi: ExtensionAPI) {
  let syncer: Syncer | null = null;
  let ctx: ExtensionContext | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  function bind(sessionCtx: ExtensionContext): Syncer {
    ctx = sessionCtx;
    syncer = createSyncer({
      run: (args, cwd) =>
        pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS }),
      getCwd: () => ctx?.cwd ?? process.cwd(),
      isIdle: () => ctx?.isIdle() ?? true,
      notify: (type, message) => {
        if (ctx?.hasUI) ctx.ui.notify(message, type);
      },
    });
    return syncer;
  }

  function intervalMs(s: Syncer): number {
    if (s.state.root) {
      const { config } = loadConfig(s.state.root);
      return Math.max(MIN_INTERVAL_MS, config.pollingIntervalMinutes * 60_000);
    }
    return FALLBACK_INTERVAL_MS;
  }

  function schedule(ms: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tickOnce(), ms);
    // Never keep the process alive just for polling (print/-p mode).
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    inFlight = false;
    syncer = null;
    ctx = null;
  }

  async function tickOnce(): Promise<void> {
    if (!syncer || inFlight) return;
    const s = syncer;
    inFlight = true;
    try {
      await s.tick();
    } catch (err) {
      console.error("[git-syncher] tick failed:", err);
    } finally {
      inFlight = false;
      if (s === syncer) schedule(intervalMs(s));
    }
  }

  pi.on("session_start", (_event, sessionCtx) => {
    const s = bind(sessionCtx);
    // First poll immediately (picks up changes made while pi was down),
    // then on the configured interval.
    schedule(0);
  });

  pi.on("session_shutdown", () => {
    stop();
  });

  pi.registerCommand("git-sync", {
    description:
      "Toggle pi-git-syncher for this repo; `git-sync status` shows state",
    handler: async (args, cmdCtx) => {
      const s = syncer ?? bind(cmdCtx);
      const arg = args.trim().toLowerCase();
      if (arg === "status") {
        const st = await s.status();
        if ("error" in st) {
          cmdCtx.ui.notify(`git-syncher: ${st.error}`, "error");
          return;
        }
        cmdCtx.ui.notify(formatStatus(st), "info");
        return;
      }
      const res = await s.toggle();
      if ("error" in res) {
        cmdCtx.ui.notify(`git-syncher: ${res.error}`, "error");
        return;
      }
      cmdCtx.ui.notify(
        `git-syncher: ${res.enabled ? "ON" : "OFF"} — ${res.root}`,
        "info",
      );
    },
  });
}

function formatStatus(st: SyncerStatus): string {
  const lines = [
    `git-syncher: ${st.enabled ? "ON" : "OFF"} (poll every ${st.pollingIntervalMinutes} min)`,
    `repo:   ${st.root}`,
    `branch: ${st.branch ?? "detached HEAD"}${st.upstream ? ` -> ${st.upstream}` : " (no upstream)"}`,
    `remote: ${st.remote ?? "none"}`,
    // Status shows local time (human-facing); commit messages keep UTC.
    `dirty:  ${st.dirty ? `yes, quiet since ${new Date(st.dirtySince ?? 0).toLocaleString()}` : "no"}`,
    `last:   ${st.lastSyncAt ? `${st.lastSyncKind} at ${new Date(st.lastSyncAt).toLocaleString()}` : "never"}`,
  ];
  if (!st.configExists)
    lines.push(`config: ${CONFIG_FILE} not found — run /git-sync to enable`);
  return lines.join("\n");
}
