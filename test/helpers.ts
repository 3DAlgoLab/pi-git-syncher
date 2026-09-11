/**
 * Shared fixtures for pi-git-syncher tests: a real git repo plus a local
 * bare "origin", a fake clock, and a notification sink.
 */

import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSyncer,
  saveConfig,
  type GitRunner,
  type GitResult,
  type Syncer,
} from "../syncer.ts";

export const MIN = 60_000;
export const DEBOUNCE = 30 * MIN;

/** Git runner for tests; isolates global/system git config. */
export function makeRun(): GitRunner {
  return (args, cwd) =>
    new Promise<GitResult>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: 30_000,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_SYSTEM: devNull,
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number }) | null;
          const code = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
          resolve({
            code,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        },
      );
    });
}

export async function sh(
  run: GitRunner,
  args: string[],
  cwd: string,
): Promise<string> {
  const res = await run(args, cwd);
  if (res.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

export async function ref(
  run: GitRunner,
  cwd: string,
  name: string,
): Promise<string> {
  return sh(run, ["rev-parse", name], cwd);
}

export interface Note {
  type: "info" | "warning" | "error";
  message: string;
}

export interface Fixture {
  dir: string;
  repo: string;
  remote: string;
  run: GitRunner;
  clock: { now: number };
  notes: Note[];
  /** Instructions the syncer handed to the (fake) agent. */
  induced: string[];
  syncer: Syncer;
  setIdle(v: boolean): void;
  /** Creates a second clone of the remote in the fixture dir. */
  otherClone(): Promise<string>;
}

export async function makeFixture(
  t: { after(fn: () => Promise<void> | void): void },
  opts: { remote?: boolean; config?: boolean; induce?: boolean } = {},
): Promise<Fixture> {
  const run = makeRun();
  const dir = await mkdtemp(join(tmpdir(), "pi-git-syncher-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const repo = join(dir, "work");
  const remote = join(dir, "origin.git");
  await mkdir(repo, { recursive: true });
  await sh(run, ["init", "-b", "main", repo], dir);
  await sh(run, ["config", "user.email", "syncher@test.local"], repo);
  await sh(run, ["config", "user.name", "Syncher Test"], repo);
  await sh(run, ["config", "commit.gpgsign", "false"], repo);
  await sh(run, ["config", "core.hooksPath", join(dir, "no-hooks")], repo);
  await writeFile(join(repo, "README.md"), "init\n");
  await sh(run, ["add", "-A"], repo);
  await sh(run, ["commit", "-m", "init"], repo);

  if (opts.remote !== false) {
    await sh(run, ["init", "--bare", "-b", "main", remote], dir);
    await sh(run, ["remote", "add", "origin", remote], repo);
    await sh(run, ["push", "-u", "origin", "main"], repo);
  }

  // Opt-in fixture default: an enabled config file exists. Tests that
  // verify the opt-out path pass { config: false }.
  if (opts.config !== false) {
    saveConfig(repo, { enabled: true, pollingIntervalMinutes: 1 });
  }
  const clock = { now: Date.now() };
  let idle = true;
  let cloneCount = 0;
  const notes: Note[] = [];
  const induced: string[] = [];
  const syncer = createSyncerForFixture({
    run,
    cwd: repo,
    clock,
    idle: () => idle,
    notes,
    induce: opts.induce === false ? undefined : (s) => induced.push(s),
  });

  return {
    dir,
    repo,
    remote,
    run,
    clock,
    notes,
    induced,
    syncer,
    setIdle: (v) => {
      idle = v;
    },
    otherClone: async () => {
      const other = join(dir, `other-${++cloneCount}`);
      await sh(run, ["clone", remote, other], dir);
      return other;
    },
  };
}

function createSyncerForFixture(opts: {
  run: GitRunner;
  cwd: string;
  clock: { now: number };
  idle: () => boolean;
  notes: Note[];
  induce?: (s: string) => void;
}): Syncer {
  return createSyncer({
    run: opts.run,
    getCwd: () => opts.cwd,
    now: () => opts.clock.now,
    isIdle: opts.idle,
    notify: (type, message) => opts.notes.push({ type, message }),
    debounceMs: DEBOUNCE,
    induce: opts.induce,
  });
}

/** Advances the fixture clock by n minutes. */
export function advance(f: Fixture, minutes: number): void {
  f.clock.now += minutes * MIN;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Pushes a new commit to the remote using a second clone. */
export async function pushRemoteCommit(
  f: Fixture,
  file: string,
  content: string,
): Promise<void> {
  const other = await f.otherClone();
  await writeFile(join(other, file), content);
  await sh(f.run, ["add", "-A"], other);
  await sh(
    f.run,
    [
      "-c",
      "user.email=other@test.local",
      "-c",
      "user.name=Other",
      "commit",
      "-m",
      `remote ${file}`,
    ],
    other,
  );
  await sh(f.run, ["push"], other);
}
