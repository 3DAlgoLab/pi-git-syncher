/**
 * Wiring test: loads the real extension factory with a fake ExtensionAPI
 * and verifies the poll loop, /git-sync toggle, and status command end to
 * end (with a real git repo and a short polling interval).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { CONFIG_FILE } from "../syncer.ts";
import { makeFixture, pushRemoteCommit, type Note } from "./helpers.ts";

interface FakePi {
  pi: ExtensionAPI;
  handlers: Record<string, Array<(event: unknown, ctx: FakeCtx) => void>>;
  commands: Record<
    string,
    {
      description: string;
      handler: (args: string, ctx: FakeCtx) => Promise<void>;
    }
  >;
}

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  mode: string;
  isIdle(): boolean;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  notes: Note[];
}

function makeFakePi(
  run: (
    args: string[],
    cwd: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): FakePi {
  const handlers: FakePi["handlers"] = {};
  const commands: FakePi["commands"] = {};
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: FakeCtx) => void) => {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, opts: FakePi["commands"][string]) => {
      commands[name] = opts;
    },
    exec: async (_cmd: string, args: string[], options?: { cwd?: string }) => {
      const res = await run(args, options?.cwd ?? process.cwd());
      return { ...res, killed: false };
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, commands };
}

function makeCtx(cwd: string): FakeCtx {
  const notes: Note[] = [];
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    ui: {
      notify: (message, type = "info") => notes.push({ type, message }),
    },
    notes,
  };
}

function waitFor(
  what: () => boolean,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const id = setInterval(() => {
      if (what()) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(id);
        reject(new Error("timeout waiting for condition"));
      }
    }, intervalMs);
  });
}

test("extension: polls, pulls, toggles, and reports status", async (t) => {
  const f = await makeFixture(t);
  const { pi, handlers, commands } = makeFakePi(f.run);
  const ctx = makeCtx(f.repo);

  // Fast polling (clamped to 5s by the extension).
  await writeFile(
    join(f.repo, CONFIG_FILE),
    JSON.stringify({ pollingIntervalMinutes: 0.05 }),
    "utf8",
  );

  extension(pi);
  assert.ok(commands["git-sync"], "/git-sync command registered");

  // A remote commit lands before the first tick -> should be pulled.
  await pushRemoteCommit(f, "pulled.txt", "remote content\n");
  for (const h of handlers["session_start"] ?? []) h({}, ctx);

  await waitFor(
    () => ctx.notes.some((n) => n.message.includes("pulled 1 new commit")),
    30_000,
  );
  assert.equal(
    await readFile(join(f.repo, "pulled.txt"), "utf8"),
    "remote content\n",
  );

  // /git-sync status shows the repo state.
  await commands["git-sync"].handler("status", ctx);
  const statusNote = ctx.notes.find((n) => n.message.includes("repo:"));
  assert.ok(statusNote, "status notification present");
  assert.ok(
    statusNote.message.includes(`repo:   ${f.repo}`),
    statusNote.message,
  );
  assert.ok(
    statusNote.message.includes("branch: main -> origin/main"),
    statusNote.message,
  );
  assert.ok(statusNote.message.includes("ON"), statusNote.message);

  // /git-sync toggles the config file off.
  await commands["git-sync"].handler("", ctx);
  assert.ok(
    ctx.notes.some((n) => n.message.includes("OFF")),
    "toggle-off notification",
  );
  const cfgOff = JSON.parse(await readFile(join(f.repo, CONFIG_FILE), "utf8"));
  assert.equal(cfgOff.enabled, false);

  // While off, nothing happens even though the remote gets a new commit.
  const notesBefore = ctx.notes.length;
  await pushRemoteCommit(f, "while-off.txt", "x\n");
  // 6.5s > one 5s poll interval: enough for a tick to have fired if the loop were active.
  await new Promise((r) => setTimeout(r, 6_500));
  assert.equal(ctx.notes.length, notesBefore, "no activity while disabled");
  assert.equal(
    await readFile(join(f.repo, "while-off.txt"), "utf8")
      .then((s) => s)
      .catch(() => "absent"),
    "absent",
  );

  // Toggle back on, then the pending remote commit is pulled on a later tick.
  await commands["git-sync"].handler("", ctx);
  assert.ok(
    ctx.notes.some((n) => n.message.includes("ON")),
    "toggle-on notification",
  );
  await waitFor(
    () =>
      ctx.notes.some(
        (n, i) => i > notesBefore && n.message.includes("pulled 1 new commit"),
      ),
    30_000,
  );

  // session_shutdown stops the loop: no further notes appear.
  for (const h of handlers["session_shutdown"] ?? []) h({}, ctx);
  await pushRemoteCommit(f, "after-shutdown.txt", "y\n");
  const notesAtShutdown = ctx.notes.length;
  // Same window: any surviving tick would be visible as a new note.
  await new Promise((r) => setTimeout(r, 6_500));
  assert.equal(
    ctx.notes.length,
    notesAtShutdown,
    "poll loop stopped after shutdown",
  );
});

test("extension: /git-sync outside a git repo reports an error", async (t) => {
  const f = await makeFixture(t, { remote: false });
  const { pi, commands } = makeFakePi(f.run);
  const ctx = makeCtx(join(f.dir, "not-a-repo"));
  extension(pi);
  await commands["git-sync"].handler("", ctx);
  assert.ok(
    ctx.notes.some(
      (n) => n.type === "error" && n.message.includes("not a git repository"),
    ),
  );
  await commands["git-sync"].handler("status", ctx);
  assert.ok(ctx.notes.filter((n) => n.type === "error").length >= 2);
});
