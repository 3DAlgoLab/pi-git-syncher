import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMIT_PREFIX,
  CONFIG_FILE,
  createSyncer,
  loadConfig,
  parseConfig,
  saveConfig,
} from "../syncer.ts";
import {
  DEBOUNCE,
  advance,
  exists,
  makeFixture,
  pushRemoteCommit,
  ref,
  sh,
} from "./helpers.ts";

test("parseConfig: defaults and validation", () => {
  assert.deepEqual(parseConfig(null), {
    enabled: true,
    pollingIntervalMinutes: 1,
  });
  assert.deepEqual(parseConfig({}), {
    enabled: true,
    pollingIntervalMinutes: 1,
  });
  assert.deepEqual(parseConfig({ enabled: false }), {
    enabled: false,
    pollingIntervalMinutes: 1,
  });
  assert.deepEqual(parseConfig({ pollingIntervalMinutes: 5 }), {
    enabled: true,
    pollingIntervalMinutes: 5,
  });
  assert.deepEqual(
    parseConfig({ enabled: "nope", pollingIntervalMinutes: -3 }),
    {
      enabled: true,
      pollingIntervalMinutes: 1,
    },
  );
  assert.equal(
    parseConfig({ pollingIntervalMinutes: 999999 }).pollingIntervalMinutes,
    1440,
  );
});

test("loadConfig: missing, valid, and corrupt files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-syncher-cfg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(loadConfig(root), {
    config: { enabled: true, pollingIntervalMinutes: 1 },
    exists: false,
  });
  saveConfig(root, { enabled: false, pollingIntervalMinutes: 2.5 });
  const loaded = loadConfig(root);
  assert.equal(loaded.exists, true);
  assert.deepEqual(loaded.config, {
    enabled: false,
    pollingIntervalMinutes: 2.5,
  });
  await writeFile(join(root, CONFIG_FILE), "{not json", "utf8");
  assert.deepEqual(loadConfig(root).config, {
    enabled: true,
    pollingIntervalMinutes: 1,
  });
});

test("pull: fast-forwards when the remote is ahead", async (t) => {
  const f = await makeFixture(t);
  await pushRemoteCommit(f, "remote.txt", "from remote\n");

  const before = await ref(f.run, f.repo, "HEAD");
  await f.syncer.tick();

  const after = await ref(f.run, f.repo, "HEAD");
  assert.notEqual(before, after);
  assert.equal(after, await ref(f.run, f.remote, "main"));
  assert.ok(
    f.notes.some(
      (n) => n.type === "info" && n.message.includes("pulled 1 new commit"),
    ),
  );
  assert.equal(f.syncer.state.lastSyncKind, "pull");
});

test("pull: does nothing when already up to date", async (t) => {
  const f = await makeFixture(t);
  const before = await ref(f.run, f.repo, "HEAD");
  await f.syncer.tick();
  assert.equal(await ref(f.run, f.repo, "HEAD"), before);
  assert.equal(f.notes.length, 0);
});

test("pull: skips while the working tree is dirty", async (t) => {
  const f = await makeFixture(t);
  await pushRemoteCommit(f, "remote.txt", "from remote\n");
  await writeFile(join(f.repo, "local.txt"), "local\n");
  await f.syncer.tick();
  const before = await ref(f.run, f.repo, "HEAD");
  assert.equal(await ref(f.run, f.repo, "HEAD"), before);
});

test("commit & push: commits after a quiet debounce", async (t) => {
  const f = await makeFixture(t, { induce: false }); // host without an agent hook
  const remoteBefore = await ref(f.run, f.remote, "main");
  await writeFile(join(f.repo, "new.txt"), "content\n");

  await f.syncer.tick(); // starts the clock
  assert.equal(f.syncer.state.dirtySince, f.clock.now);
  advance(f, 29);
  await f.syncer.tick();
  assert.equal(await ref(f.run, f.remote, "main"), remoteBefore); // still waiting

  advance(f, 2); // 31 quiet minutes
  await f.syncer.tick();
  assert.equal(
    await ref(f.run, f.remote, "main"),
    await ref(f.run, f.repo, "HEAD"),
  );
  assert.notEqual(await ref(f.run, f.remote, "main"), remoteBefore);
  const subject = await sh(f.run, ["log", "-1", "--format=%s"], f.repo);
  assert.ok(subject.startsWith(COMMIT_PREFIX), subject);
  assert.ok(
    f.notes.some(
      (n) =>
        n.type === "info" && n.message.includes("committed & pushed 1 file"),
    ),
  );
  assert.equal(f.syncer.state.dirtySince, null);
  // The file actually landed on the remote.
  assert.equal(await sh(f.run, ["show", "main:new.txt"], f.remote), "content"); // sh() trims
});

test("commit & push: repeated edits to the same file restart the clock", async (t) => {
  const f = await makeFixture(t, { induce: false }); // host without an agent hook
  const remoteBefore = await ref(f.run, f.remote, "main");
  await writeFile(join(f.repo, "a.txt"), "v1\n");
  await f.syncer.tick(); // t0: clock starts
  advance(f, 20);
  await f.syncer.tick(); // unchanged, no reset
  assert.equal(f.syncer.state.dirtySince, f.clock.now - 20 * 60_000);

  await new Promise((r) => setTimeout(r, 20)); // mtime granularity
  await writeFile(join(f.repo, "a.txt"), "v2\n"); // new change at t0+20
  await f.syncer.tick();
  assert.equal(f.syncer.state.dirtySince, f.clock.now);

  advance(f, 29);
  await f.syncer.tick();
  assert.equal(await ref(f.run, f.remote, "main"), remoteBefore); // 29 min since reset
  advance(f, 2);
  await f.syncer.tick();
  assert.notEqual(await ref(f.run, f.remote, "main"), remoteBefore); // committed
});

test("commit & push: waits while the agent is busy", async (t) => {
  const f = await makeFixture(t, { induce: false }); // host without an agent hook
  const remoteBefore = await ref(f.run, f.remote, "main");
  await writeFile(join(f.repo, "busy.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  f.setIdle(false);
  await f.syncer.tick();
  assert.equal(await ref(f.run, f.remote, "main"), remoteBefore);
  f.setIdle(true);
  await f.syncer.tick();
  assert.notEqual(await ref(f.run, f.remote, "main"), remoteBefore);
});

test("commit & push: skipped when the config disables the features", async (t) => {
  const f = await makeFixture(t);
  saveConfig(f.repo, { enabled: false, pollingIntervalMinutes: 1 });
  const remoteBefore = await ref(f.run, f.remote, "main");
  await writeFile(join(f.repo, "off.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick();
  assert.equal(await ref(f.run, f.remote, "main"), remoteBefore);
  assert.equal(f.notes.length, 0);
});

test("commit & push: skipped without a remote", async (t) => {
  const f = await makeFixture(t, { remote: false });
  await writeFile(join(f.repo, "lonely.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick();
  const localHead = await sh(f.run, ["log", "-1", "--format=%s"], f.repo);
  assert.equal(localHead, "init"); // nothing was committed
  assert.ok(
    f.notes.some(
      (n) => n.type === "warning" && n.message.includes("no remote"),
    ),
  );
});

test("push: retries a failed push once the remote is reachable again", async (t) => {
  const f = await makeFixture(t, { induce: false }); // host without an agent hook
  await writeFile(join(f.repo, "x.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  await chmod(f.remote, 0o555); // push fails (local transport can't write refs)
  await f.syncer.tick(); // commit lands locally, push fails once
  assert.equal(
    (await sh(f.run, ["log", "-1", "--format=%s"], f.repo)).startsWith(
      COMMIT_PREFIX,
    ),
    true,
  );
  assert.ok(
    f.notes.some(
      (n) => n.type === "warning" && n.message.includes("push failed"),
    ),
  );
  await f.syncer.tick(); // clean tree, still blocked: no duplicate warning
  const warnings = f.notes.filter((n) =>
    n.message.includes("push failed"),
  ).length;
  await chmod(f.remote, 0o755);
  await f.syncer.tick(); // remote reachable again -> push succeeds
  assert.equal(warnings, 1);
  assert.equal(
    await ref(f.run, f.remote, "main"),
    await ref(f.run, f.repo, "HEAD"),
  );
  assert.ok(f.notes.some((n) => n.message.includes("pushed 1 pending commit")));
});

test("diverged: warns once and does not touch the history", async (t) => {
  const f = await makeFixture(t);
  // Local commit on main...
  await writeFile(join(f.repo, "local.txt"), "local\n");
  await sh(f.run, ["add", "-A"], f.repo);
  await sh(f.run, ["commit", "-m", "local work"], f.repo);
  // ...and an independent remote commit.
  await pushRemoteCommit(f, "remote.txt", "remote\n");

  const headBefore = await ref(f.run, f.repo, "HEAD");
  await f.syncer.tick();
  assert.equal(await ref(f.run, f.repo, "HEAD"), headBefore);
  await f.syncer.tick();
  const diverged = f.notes.filter((n) => n.message.includes("diverged"));
  assert.equal(diverged.length, 1);
  assert.equal(diverged[0].type, "warning");
});

test("toggle: writes the config file and flips the flag", async (t) => {
  const f = await makeFixture(t);
  const res1 = await f.syncer.toggle();
  if ("error" in res1) throw new Error(res1.error);
  assert.equal(res1.root, f.repo);
  assert.equal(res1.enabled, false);
  assert.equal(
    (await readFile(join(f.repo, CONFIG_FILE), "utf8")).includes(
      '"enabled": false',
    ),
    true,
  );
  const res2 = await f.syncer.toggle();
  if ("error" in res2) throw new Error(res2.error);
  assert.equal(res2.enabled, true);
});

test("tick: is a no-op outside a git repository", async (t) => {
  const f = await makeFixture(t, { remote: false });
  // Point the syncer at an empty non-repo directory.
  const stray = join(f.dir, "stray");
  await mkdir(stray);
  const syncer = createSyncer({
    run: f.run,
    getCwd: () => stray,
    now: () => f.clock.now,
    debounceMs: DEBOUNCE,
  });
  await syncer.tick(); // must not throw
  assert.equal(syncer.state.root, null);
  const st = await syncer.status();
  assert.equal("error" in st, true);
});

test("config file: an untracked .git-syncher.json does not make the repo dirty", async (t) => {
  const f = await makeFixture(t);
  await pushRemoteCommit(f, "remote.txt", "from remote\n");
  // Toggling creates the (untracked) config file.
  await f.syncer.toggle();
  await f.syncer.toggle();
  const exclude = await readFile(
    join(f.repo, ".git", "info", "exclude"),
    "utf8",
  );
  assert.ok(
    exclude.includes(CONFIG_FILE),
    "config file listed in .git/info/exclude",
  );
  await f.syncer.tick();
  assert.equal(
    f.syncer.state.dirtySince,
    null,
    "no dirty clock for a config-only change",
  );
  assert.equal(
    await ref(f.run, f.repo, "HEAD"),
    await ref(f.run, f.remote, "main"),
  );
  assert.ok(f.notes.some((n) => n.message.includes("pulled 1 new commit")));
});

test("opt-in: without a config file the repo is left alone; the first /git-sync enables it", async (t) => {
  const f = await makeFixture(t, { config: false });

  // Opted out: 31 quiet minutes on a dirty tree commit nothing.
  await writeFile(join(f.repo, "local.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick();
  assert.equal(await sh(f.run, ["log", "-1", "--format=%s"], f.repo), "init");

  // Opted out: with a clean tree, a pending remote commit is not pulled.
  await rm(join(f.repo, "local.txt"));
  await pushRemoteCommit(f, "remote.txt", "from remote\n");
  await f.syncer.tick();
  assert.equal(await exists(join(f.repo, "remote.txt")), false);

  // First toggle opts in: creates the enabled config file.
  const res = await f.syncer.toggle();
  if ("error" in res) throw new Error(res.error);
  assert.equal(res.enabled, true);
  assert.ok(
    (await readFile(join(f.repo, CONFIG_FILE), "utf8")).includes(
      '"enabled": true',
    ),
  );

  // Now the same pending remote commit is pulled on the next tick.
  await f.syncer.tick();
  assert.equal(await exists(join(f.repo, "remote.txt")), true);
  assert.equal(
    await ref(f.run, f.repo, "HEAD"),
    await ref(f.run, f.remote, "main"),
  );
});

test("diverged: induces the agent once per episode", async (t) => {
  const f = await makeFixture(t);
  await pushRemoteCommit(f, "remote.txt", "r\n");
  await sh(f.run, ["commit", "--allow-empty", "-m", "local"], f.repo);
  await f.syncer.tick();
  assert.equal(f.induced.length, 1);
  assert.ok(f.induced[0].includes("git merge origin/main"));
  assert.ok(f.induced[0].includes("1 commit(s) ahead and 1 commit(s) behind"));

  // Same episode on the next tick: no second induction.
  await f.syncer.tick();
  assert.equal(f.induced.length, 1);
});

test("diverged: a resolved episode re-arms the induction", async (t) => {
  const f = await makeFixture(t);
  await pushRemoteCommit(f, "remote.txt", "r\n");
  await sh(f.run, ["commit", "--allow-empty", "-m", "local"], f.repo);
  await f.syncer.tick();
  assert.equal(f.induced.length, 1);

  // The agent resolves: merge + push.
  await sh(f.run, ["merge", "origin/main", "--no-edit"], f.repo);
  await sh(f.run, ["push"], f.repo);
  await f.syncer.tick(); // clean + up to date: re-arms

  // A fresh divergence with the same counts induces again.
  await pushRemoteCommit(f, "remote2.txt", "r2\n");
  await sh(f.run, ["commit", "--allow-empty", "-m", "local2"], f.repo);
  await f.syncer.tick();
  assert.equal(f.induced.length, 2);
});

test("merge in progress: a conflicted merge is never auto-committed", async (t) => {
  const f = await makeFixture(t);
  await writeFile(join(f.repo, "README.md"), "local edit\n");
  await sh(f.run, ["add", "-A"], f.repo);
  await sh(f.run, ["commit", "-m", "local"], f.repo);

  const other = await f.otherClone();
  await writeFile(join(other, "README.md"), "remote edit\n");
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
      "remote",
    ],
    other,
  );
  await sh(f.run, ["push"], other);

  // Start the merge: it conflicts, MERGE_HEAD is set, tree is dirty.
  await sh(f.run, ["fetch", "origin"], f.repo);
  const merge = await f.run(["merge", "origin/main"], f.repo);
  assert.notEqual(merge.code, 0, "expected a conflict");
  assert.equal(
    await sh(f.run, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], f.repo),
    await ref(f.run, f.remote, "main"),
    "merge in progress",
  );

  // 31 quiet minutes do not commit the conflicted state.
  advance(f, 31);
  await f.syncer.tick();
  assert.equal(
    f.induced.length,
    0,
    "no agent induction while a merge is in progress",
  );
  assert.equal(
    await sh(f.run, ["log", "-1", "--format=%s"], f.repo),
    "local",
    "no auto-commit while a merge is in progress",
  );
});
test("commit: with an agent hook, the idle agent writes the message", async (t) => {
  const f = await makeFixture(t);
  const remoteBefore = await ref(f.run, f.remote, "main");
  await writeFile(join(f.repo, "new.txt"), "content\n");

  await f.syncer.tick(); // starts the clock
  advance(f, 31);
  await f.syncer.tick();

  // Nothing committed yet: the agent was asked instead.
  assert.equal(await ref(f.run, f.remote, "main"), remoteBefore);
  assert.equal(f.induced.length, 1);
  assert.ok(f.induced[0].includes("git_syncher_commit"), f.induced[0]);
  // The changes were staged for the agent to inspect.
  const staged = await f.run(["diff", "--cached", "--stat"], f.repo);
  assert.ok(staged.stdout.includes("new.txt"), staged.stdout);

  // The agent calls back with its message.
  const res = await f.syncer.commitStaged("feat: add new.txt");
  assert.equal(res.ok, true);
  assert.equal(
    await ref(f.run, f.remote, "main"),
    await ref(f.run, f.repo, "HEAD"),
  );
  assert.equal(
    await sh(f.run, ["log", "-1", "--format=%s"], f.repo),
    "feat: add new.txt",
  );
  assert.equal(await sh(f.run, ["show", "main:new.txt"], f.remote), "content");
  assert.equal(f.syncer.state.dirtySince, null);
  assert.ok(
    f.notes.some(
      (n) =>
        n.type === "info" &&
        n.message.includes("committed & pushed: feat: add new.txt"),
    ),
  );
});

test("commit: at most one agent induction per quiet window", async (t) => {
  const f = await makeFixture(t);
  await writeFile(join(f.repo, "a.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick();
  assert.equal(f.induced.length, 1);

  // Next poll, same dirty state: no second induction.
  advance(f, 1);
  await f.syncer.tick();
  assert.equal(f.induced.length, 1);

  // A full debounce window later the (failed) attempt is retried once.
  advance(f, 30);
  await f.syncer.tick();
  assert.equal(f.induced.length, 2);
});

test("commit: a new change after an induction restarts the cycle", async (t) => {
  const f = await makeFixture(t);
  await writeFile(join(f.repo, "a.txt"), "v1\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick();
  assert.equal(f.induced.length, 1);

  // The user edits again: the debounce clock restarts.
  await new Promise((r) => setTimeout(r, 20)); // mtime granularity
  await writeFile(join(f.repo, "a.txt"), "v2\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick();
  assert.equal(f.induced.length, 2);
});

test("commitStaged: refuses while a merge is in progress", async (t) => {
  const f = await makeFixture(t);
  await writeFile(join(f.repo, "README.md"), "local edit\n");
  await sh(f.run, ["add", "-A"], f.repo);
  await sh(f.run, ["commit", "-m", "local"], f.repo);
  const other = await f.otherClone();
  await writeFile(join(other, "README.md"), "remote edit\n");
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
      "remote",
    ],
    other,
  );
  await sh(f.run, ["push"], other);
  await sh(f.run, ["fetch", "origin"], f.repo);
  const merge = await f.run(["merge", "origin/main"], f.repo);
  assert.notEqual(merge.code, 0, "expected a conflict");

  const res = await f.syncer.commitStaged("feat: x");
  assert.equal(res.ok, false);
  assert.ok((res.error ?? "").includes("merge"), res.error);
  assert.equal(await sh(f.run, ["log", "-1", "--format=%s"], f.repo), "local");
});

test("commitStaged: refuses when nothing is staged", async (t) => {
  const f = await makeFixture(t);
  const res = await f.syncer.commitStaged("feat: nothing");
  assert.equal(res.ok, false);
  assert.ok((res.error ?? "").includes("nothing is staged"), res.error);
});

test("commitStaged: a failed push keeps the commit local and retries on the next sync", async (t) => {
  const f = await makeFixture(t);
  await writeFile(join(f.repo, "x.txt"), "x\n");
  await f.syncer.tick();
  advance(f, 31);
  await f.syncer.tick(); // stages + induces
  assert.equal(f.induced.length, 1);

  await chmod(f.remote, 0o555); // push fails (local transport can't write refs)
  const res = await f.syncer.commitStaged("feat: x");
  assert.equal(res.ok, false);
  assert.ok((res.error ?? "").includes("push failed"), res.error);
  assert.equal(
    await sh(f.run, ["log", "-1", "--format=%s"], f.repo),
    "feat: x",
  );

  await chmod(f.remote, 0o755);
  await f.syncer.tick(); // clean tree: pushes the pending commit
  assert.equal(
    await ref(f.run, f.remote, "main"),
    await ref(f.run, f.repo, "HEAD"),
  );
  assert.ok(f.notes.some((n) => n.message.includes("pushed 1 pending commit")));
});
