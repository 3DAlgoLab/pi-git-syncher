/**
 * Pi Git Syncher — core engine.
 *
 * Tracks one git repository (the toplevel of `getCwd()`) and performs:
 *
 * - Automatic commit & push: while the working tree is dirty, a 30-minute
 *   debounce clock runs. Any new change (fingerprint change of the dirty
 *   state) restarts the clock. When the clock expires and pi is idle, the
 *   engine stages everything and, if an agent hook is available, hands the
 *   idle agent the job of writing a proper commit message: the agent calls
 *   the host's git_syncher_commit tool, and the engine commits & pushes.
 *   Without an agent hook it falls back to a fixed `chore(git-syncher)`
 *   message.
 * - Automatic retrieving: while the working tree is clean, the engine
 *   fetches and, if the remote is ahead, runs `git pull --ff-only`.
 *   Pending local commits are pushed first (e.g. after a failed push).
 *
 * The engine is transport-agnostic: git access goes through an injected
 * runner, time through an injected clock, so it is fully unit-testable.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = ".git-syncher.json";
export const DEFAULT_POLLING_MINUTES = 1;
export const DEFAULT_DEBOUNCE_MS = 30 * 60 * 1000;
export const COMMIT_PREFIX = "chore(git-syncher)";

const MAX_POLLING_MINUTES = 1440;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommitStagedResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/** Runs `git <args>` in `cwd`. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export interface GitSyncherConfig {
  /** Master switch for all features. Default: true. */
  enabled: boolean;
  /** Minutes between polls. Default: 1. */
  pollingIntervalMinutes: number;
}

export interface SyncerOptions {
  run: GitRunner;
  /** Directory the session runs in; its containing repo is the synced one. */
  getCwd: () => string;
  now?: () => number;
  isIdle?: () => boolean;
  notify?: (type: "info" | "warning" | "error", message: string) => void;
  debounceMs?: number;
  /**
   * Called when the local branch has diverged from its upstream, with an
   * instruction to hand to the running agent (merge + push). The syncher
   * itself never merges a diverged branch.
   */
  induce?: (instruction: string) => void | Promise<void>;
}

export interface SyncerState {
  /** Repo root of the current cwd, or null when not inside a repo. */
  root: string | null;
  /** When the current unchanging-dirty streak started, or null. */
  dirtySince: number | null;
  /** Fingerprint of the dirty state when `dirtySince` was (re)set. */
  snapshot: string | null;
  /** Whether the config file was added to .git/info/exclude this session. */
  excludedConfig: boolean;
  /** One-shot warnings already reported this session. */
  warned: Set<string>;
  /**
   * 'branch:ahead:behind' key of the divergence episode for which the agent
   * was already induced; null when no episode is active. A different key
   * (or a fresh divergence after resolution) induces again.
   */
  inducedDivergence: string | null;
  /**
   * Clock time of the last auto-commit induction for the current dirty
   * streak, or null. Re-induction is allowed at most once per debounce
   * window, so a failed agent turn retries quietly instead of spamming.
   */
  commitInducedAt: number | null;
  lastSyncAt: number | null;
  lastSyncKind: "commit" | "pull" | null;
}

export interface SyncerStatus {
  root: string;
  enabled: boolean;
  configPath: string;
  configExists: boolean;
  pollingIntervalMinutes: number;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  dirty: boolean;
  dirtySince: number | null;
  debounceMs: number;
  lastSyncAt: number | null;
  lastSyncKind: "commit" | "pull" | null;
}

export interface Syncer {
  readonly state: SyncerState;
  /** One poll cycle. Errors are reported via notify/log, never thrown. */
  tick(): Promise<void>;
  /** Flips `enabled` in the config file (created if missing). */
  toggle(): Promise<{ root: string; enabled: boolean } | { error: string }>;
  status(): Promise<SyncerStatus | { error: string }>;
  /**
   * Commits the already-staged changes with the agent-generated message
   * and pushes. Invoked by the host's git_syncher_commit tool; the
   * syncher keeps control of the actual git operations.
   */
  commitStaged(message: string): Promise<CommitStagedResult>;
}

/** Parses a raw config value; invalid fields fall back to defaults. */
export function parseConfig(raw: unknown): GitSyncherConfig {
  const config: GitSyncherConfig = {
    enabled: true,
    pollingIntervalMinutes: DEFAULT_POLLING_MINUTES,
  };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.enabled === "boolean") config.enabled = obj.enabled;
    if (
      typeof obj.pollingIntervalMinutes === "number" &&
      Number.isFinite(obj.pollingIntervalMinutes) &&
      obj.pollingIntervalMinutes > 0
    ) {
      config.pollingIntervalMinutes = Math.min(
        obj.pollingIntervalMinutes,
        MAX_POLLING_MINUTES,
      );
    }
  }
  return config;
}

export function loadConfig(root: string): {
  config: GitSyncherConfig;
  exists: boolean;
} {
  try {
    const raw = readFileSync(join(root, CONFIG_FILE), "utf8");
    return { config: parseConfig(JSON.parse(raw)), exists: true };
  } catch {
    return { config: parseConfig(null), exists: false };
  }
}

export function saveConfig(root: string, config: GitSyncherConfig): void {
  writeFileSync(
    join(root, CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Instruction handed to the running agent when the branch has diverged.
 * Deliberately prescribes a merge (never a rebase/force-push): the local
 * commits are usually already pushed-then-rejected and may be shared.
 */
export function divergenceInstruction(
  branch: string,
  ahead: number,
  behind: number,
): string {
  return [
    "[pi-git-syncher] This repo's local branch has diverged from its remote (a push was rejected, non-fast-forward).",
    `Branch '${branch}' is ${ahead} commit(s) ahead and ${behind} commit(s) behind origin/${branch}.`,
    "Resolve the git sync now:",
    "1. git fetch origin",
    `2. git merge origin/${branch} — if there are conflicts, edit the conflicted files to combine both sides, then git add and git commit`,
    "3. git push",
    "Do not rewrite shared history (no rebase, no force-push). If the merge cannot be resolved safely, stop and report the conflicts.",
  ].join("\n");
}

/**
 * Instruction handed to the idle agent when the debounce clock expires: the
 * engine has staged everything; the agent only writes a proper message and
 * calls the host's git_syncher_commit tool.
 */
export function commitMessageInstruction(branch: string): string {
  return [
    `[pi-git-syncher] Auto-commit window on branch '${branch}': the repo has uncommitted changes that have been quiet for 30 minutes.`,
    "The changes are already staged (git add -A). Produce the commit:",
    "1. Review the staged changes: `git diff --cached` (start with `git diff --cached --stat` if the diff is large)",
    "2. Match the repo's commit style: `git log --oneline -10`",
    '3. Call the `git_syncher_commit` tool with { "message": "..." } — it commits the staged changes and pushes. Do not run git commit/push yourself and do not edit any files.',
    "Message rules: one concise commit — imperative subject line (max 72 chars) describing what actually changed; a short body only if it adds real context. If the staged diff turns out empty, stop and say so.",
  ].join("\n");
}

export function createSyncer(options: SyncerOptions): Syncer {
  const run = options.run;
  const now = options.now ?? Date.now;
  const isIdle = options.isIdle ?? (() => true);
  const notify = options.notify ?? (() => {});
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const induce = options.induce;

  const state: SyncerState = {
    root: null,
    dirtySince: null,
    snapshot: null,
    excludedConfig: false,
    warned: new Set(),
    inducedDivergence: null,
    commitInducedAt: null,
    lastSyncAt: null,
    lastSyncKind: null,
  };

  const git = (args: string[], cwd: string): Promise<GitResult> =>
    run(args, cwd);

  function warnOnce(key: string, message: string): void {
    if (state.warned.has(key)) return;
    state.warned.add(key);
    notify("warning", `git-syncher: ${message}`);
  }

  function markSync(kind: "commit" | "pull"): void {
    state.lastSyncAt = now();
    state.lastSyncKind = kind;
  }

  async function repoRoot(): Promise<string | null> {
    const res = await git(["rev-parse", "--show-toplevel"], options.getCwd());
    const root = res.stdout.trim();
    return res.code === 0 && root ? root : null;
  }

  /** Current branch name, or null when detached. */
  async function currentBranch(root: string): Promise<string | null> {
    const res = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
    return res.code === 0 ? res.stdout.trim() || null : null;
  }

  async function remoteUrl(root: string): Promise<string | null> {
    const res = await git(["remote", "get-url", "origin"], root);
    return res.code === 0 ? res.stdout.trim() || null : null;
  }

  /**
   * Keeps the config file out of dirty detection when it is untracked:
   * adds it to the repo-local .git/info/exclude (no tracked file touched).
   * If the user commits the config deliberately, exclude has no effect and
   * normal tracking applies.
   */
  async function ensureConfigExcluded(root: string): Promise<void> {
    if (state.excludedConfig) return;
    try {
      const gitDirRes = await git(["rev-parse", "--absolute-git-dir"], root);
      if (gitDirRes.code !== 0) return;
      const excludePath = join(gitDirRes.stdout.trim(), "info", "exclude");
      mkdirSync(join(gitDirRes.stdout.trim(), "info"), { recursive: true });
      const current = existsSync(excludePath)
        ? readFileSync(excludePath, "utf8")
        : "";
      if (!current.split("\n").includes(CONFIG_FILE)) {
        appendFileSync(excludePath, `${CONFIG_FILE}\n`, "utf8");
      }
      state.excludedConfig = true;
    } catch {
      // Best effort: non-standard git layouts (rare) just keep normal behavior.
    }
  }
  async function hasUpstream(root: string): Promise<boolean> {
    const res = await git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      root,
    );
    return res.code === 0;
  }

  async function revCount(root: string, range: string): Promise<number | null> {
    const res = await git(["rev-list", "--count", range], root);
    if (res.code !== 0) return null;
    const n = parseInt(res.stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  async function commitAndPush(
    root: string,
    branch: string,
    fileCount: number,
  ): Promise<boolean> {
    const remote = await remoteUrl(root);
    if (!remote) {
      warnOnce("no-remote", "no remote 'origin'; commit & push skipped");
      return false;
    }
    const message = `${COMMIT_PREFIX}: auto-commit ${fileCount} file(s), ${new Date(now()).toISOString()}`;
    const add = await git(["add", "-A"], root);
    if (add.code !== 0) {
      warnOnce(
        "add-failed",
        `git add failed: ${firstLine(add.stderr || add.stdout)}`,
      );
      return false;
    }
    const commit = await git(["commit", "-m", message], root);
    if (commit.code !== 0) {
      warnOnce(
        "commit-failed",
        `git commit failed: ${firstLine(commit.stderr || commit.stdout)}`,
      );
      return false;
    }
    const upstream = await hasUpstream(root);
    const push = await git(
      upstream ? ["push"] : ["push", "-u", "origin", branch],
      root,
    );
    if (push.code !== 0) {
      warnOnce(
        "push-failed",
        `push failed: ${firstLine(push.stderr || push.stdout)}`,
      );
      return false;
    }
    markSync("commit");
    notify("info", `git-syncher: committed & pushed ${fileCount} file(s)`);
    return true;
  }

  /**
   * Commits the already-staged changes with the agent-generated message and
   * pushes. Invoked by the host's git_syncher_commit tool. Never stages
   * anything: the tick that induced the agent staged exactly what it
   * reviewed, and anything new is left for the next cycle.
   */
  async function commitStaged(message: string): Promise<CommitStagedResult> {
    const root = await repoRoot();
    if (!root) return { ok: false, error: "not a git repository" };
    const mergeHead = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], root);
    if (mergeHead.code === 0) {
      return {
        ok: false,
        error: "a merge is in progress; resolve it before committing",
      };
    }
    const branch = await currentBranch(root);
    if (!branch) {
      return { ok: false, error: "detached HEAD; refusing to commit" };
    }
    const remote = await remoteUrl(root);
    if (!remote) {
      return { ok: false, error: "no remote 'origin'; refusing to commit" };
    }
    const staged = await git(["diff", "--cached", "--quiet"], root);
    if (staged.code === 0) {
      return { ok: false, error: "nothing is staged; nothing to commit" };
    }
    const text = message.trim();
    if (!text) return { ok: false, error: "the commit message is empty" };
    const commit = await git(["commit", "-m", text], root);
    if (commit.code !== 0) {
      return {
        ok: false,
        error: `git commit failed: ${firstLine(commit.stderr || commit.stdout)}`,
      };
    }
    // The staged set is committed; the dirty streak is over. If new
    // unstaged changes appeared meanwhile, the next tick starts a fresh
    // debounce clock for them.
    state.dirtySince = null;
    state.snapshot = null;
    state.commitInducedAt = null;
    const upstream = await hasUpstream(root);
    const push = await git(
      upstream ? ["push"] : ["push", "-u", "origin", branch],
      root,
    );
    if (push.code !== 0) {
      // The commit stays local; the clean-tree path retries the push.
      const detail = firstLine(push.stderr || push.stdout);
      notify(
        "warning",
        `push failed: ${detail} (commit kept local, will retry)`,
      );
      return {
        ok: false,
        error: `committed locally, but the push failed: ${detail} — it will be pushed on the next sync`,
      };
    }
    markSync("commit");
    notify("info", `git-syncher: committed & pushed: ${text.split("\n")[0]}`);
    return { ok: true };
  }

  /** For a clean tree: push pending local commits, then ff-only pull if behind. */
  async function syncCleanTree(root: string, branch: string): Promise<void> {
    const remote = await remoteUrl(root);
    if (!remote) {
      warnOnce("no-remote", "no remote 'origin'; auto sync skipped");
      return;
    }
    if (!(await hasUpstream(root))) {
      warnOnce(
        "no-upstream",
        `branch '${branch}' has no upstream; auto sync skipped`,
      );
      return;
    }
    const fetch = await git(["fetch", "origin"], root);
    if (fetch.code !== 0) return; // offline or transient; retry on the next poll
    const ahead = await revCount(root, "@{u}..HEAD");
    const behind = await revCount(root, "HEAD..@{u}");
    if (ahead === null || behind === null) return;

    if (ahead > 0 && behind > 0) {
      warnOnce(
        "diverged",
        `local branch diverged from origin/${branch}; ${
          induce ? "asked the agent to resolve" : "resolve manually"
        }`,
      );
      // One agent induction per divergence episode (same branch + counts).
      const key = `${branch}:${ahead}:${behind}`;
      if (induce && state.inducedDivergence !== key) {
        state.inducedDivergence = key;
        await induce(divergenceInstruction(branch, ahead, behind));
      }
      return;
    }
    // Not diverged: re-arm the induction for a future episode.
    state.inducedDivergence = null;
    if (ahead > 0) {
      const push = await git(["push"], root);
      if (push.code === 0) {
        markSync("commit");
        notify("info", `git-syncher: pushed ${ahead} pending commit(s)`);
      } else {
        warnOnce(
          "push-failed",
          `push failed: ${firstLine(push.stderr || push.stdout)}`,
        );
      }
      return;
    }
    if (behind > 0) {
      const pull = await git(["pull", "--ff-only"], root);
      if (pull.code === 0) {
        markSync("pull");
        notify(
          "info",
          `git-syncher: pulled ${behind} new commit(s) from origin/${branch}`,
        );
      } else {
        warnOnce(
          "pull-failed",
          `pull failed: ${firstLine(pull.stderr || pull.stdout)}`,
        );
      }
    }
  }

  /**
   * Fingerprint of the dirty state: HEAD plus each dirty path with its
   * mtime. Repeated edits to the same file change the mtime, so they reset
   * the debounce clock even though the porcelain output looks identical.
   */
  async function fingerprint(root: string, status: string): Promise<string> {
    const head = await git(["rev-parse", "HEAD"], root);
    const parts: string[] = [head.code === 0 ? head.stdout.trim() : "?"];
    for (const line of status.split("\n")) {
      if (!line.trim()) continue;
      const path = porcelainPath(line);
      if (!path) continue;
      let mtime = "?";
      try {
        mtime = String(statSync(join(root, path)).mtimeMs);
      } catch {
        // Path vanished between `status` and `stat`; the status line will
        // change on the next poll anyway.
      }
      parts.push(`${path}@${mtime}`);
    }
    return parts.join("|");
  }

  /** Extracts the (destination) path from one porcelain status line. */
  function porcelainPath(line: string): string | null {
    const rest = line.slice(3).trim();
    if (!rest) return null;
    const arrow = rest.indexOf(" -> ");
    const target = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    if (target.length >= 2 && target.startsWith('"') && target.endsWith('"')) {
      try {
        return JSON.parse(target);
      } catch {
        return target.slice(1, -1);
      }
    }
    return target;
  }

  async function tick(): Promise<void> {
    const root = await repoRoot();
    if (!root) {
      state.root = null;
      return;
    }
    state.root = root;
    const { config, exists } = loadConfig(root);
    if (exists && !state.excludedConfig) await ensureConfigExcluded(root);
    // Opt-in: the features are off while the config file does not exist.
    if (!exists || !config.enabled) return;
    const branch = await currentBranch(root);
    if (!branch) return; // detached HEAD: leave the repo alone
    const statusRes = await git(
      ["-c", "core.quotePath=false", "status", "--porcelain"],
      root,
    );
    if (statusRes.code !== 0) return;

    if (statusRes.stdout.trim()) {
      const t = now();
      const snap = await fingerprint(root, statusRes.stdout);
      if (state.dirtySince === null || snap !== state.snapshot) {
        state.dirtySince = t;
        state.snapshot = snap;
      }
      if (t - state.dirtySince >= debounceMs && isIdle()) {
        // A merge in progress (e.g. the agent resolving a divergence) must
        // not be auto-committed: `add -A` + `commit` would bake conflict
        // markers into history.
        const mergeHead = await git(
          ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          root,
        );
        if (mergeHead.code === 0) return;
        if (induce) {
          // The agent is idle, so it writes the commit message. Stage
          // everything, then ask the agent to review the staged diff and
          // call the git_syncher_commit tool. At most one induction per
          // debounce window, so a failed agent turn retries quietly.
          if (
            state.commitInducedAt !== null &&
            t - state.commitInducedAt < debounceMs
          ) {
            return;
          }
          const remote = await remoteUrl(root);
          if (!remote) {
            warnOnce("no-remote", "no remote 'origin'; auto-commit skipped");
            return;
          }
          const add = await git(["add", "-A"], root);
          if (add.code !== 0) {
            warnOnce(
              "add-failed",
              `git add failed: ${firstLine(add.stderr || add.stdout)}`,
            );
            return;
          }
          state.commitInducedAt = t;
          await induce(commitMessageInstruction(branch));
          return;
        }
        // No agent hook: fall back to the fixed message.
        const files = statusRes.stdout
          .split("\n")
          .filter((l) => l.trim()).length;
        if (await commitAndPush(root, branch, files)) {
          state.dirtySince = null;
          state.snapshot = null;
        }
      }
      return;
    }

    state.dirtySince = null;
    state.snapshot = null;
    state.commitInducedAt = null;
    await syncCleanTree(root, branch);
  }

  async function toggle(): Promise<
    { root: string; enabled: boolean } | { error: string }
  > {
    const root = await repoRoot();
    if (!root) return { error: "not a git repository" };
    const { config, exists } = loadConfig(root);
    // First toggle on a repo without config opts in: creates the file, ON.
    const next = { ...config, enabled: exists ? !config.enabled : true };
    saveConfig(root, next);
    await ensureConfigExcluded(root);
    // Re-enabling starts a fresh debounce clock.
    state.dirtySince = null;
    state.snapshot = null;
    state.commitInducedAt = null;
    state.warned.clear();
    return { root, enabled: next.enabled };
  }

  async function status(): Promise<SyncerStatus | { error: string }> {
    const root = await repoRoot();
    if (!root) return { error: "not a git repository" };
    const { config, exists } = loadConfig(root);
    const branch = await currentBranch(root);
    const upstreamRes = await git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      root,
    );
    return {
      root,
      enabled: exists && config.enabled, // effective state (opt-in)
      configPath: join(root, CONFIG_FILE),
      configExists: exists,
      pollingIntervalMinutes: config.pollingIntervalMinutes,
      branch,
      upstream: upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null,
      remote: await remoteUrl(root),
      dirty: state.dirtySince !== null,
      dirtySince: state.dirtySince,
      debounceMs,
      lastSyncAt: state.lastSyncAt,
      lastSyncKind: state.lastSyncKind,
    };
  }

  return { state, tick, toggle, status, commitStaged };
}

function firstLine(text: string): string {
  const line = text
    .trim()
    .split("\n")
    .find((l) => l.trim());
  return line ? line.trim().slice(0, 200) : "unknown error";
}
