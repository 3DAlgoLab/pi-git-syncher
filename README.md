# pi-git-syncher

A [pi](https://pi.dev) coding-agent extension that keeps your git repo in sync while you (or the agent) work:

- **Automatic commit & push** — polls the repo on an interval. When the working tree is dirty, a debounce clock starts (`debounceMinutes`, default 30); any new change restarts it. Once the tree has been quiet for that long and pi is idle, it stages everything and asks the idle agent to write a proper commit message; the agent commits via the `git_syncher_commit` tool, which also pushes.
- **Automatic retrieving** — on each poll, if the working tree is clean and the remote has new commits, it runs `git pull --ff-only`. If the branch has diverged (push rejected elsewhere), it asks the running agent to resolve it (`git merge origin/<branch>` + push) — the syncher itself never auto-merges.
- **Silent by design** — no notifications except for actual sync events (committed & pushed / pulled) and one-shot warnings for problems you should know about (push failed, branch diverged, no remote).

## Install

```bash
pi install git:github.com/3DAlgoLab/pi-git-syncher
```

or copy the repo into `~/.pi/agent/extensions/` (global) / `.pi/extensions/` (project). The extension loads in any pi session, regardless of directory.

## Usage

In any repo, type:

```text
/git-sync            # toggle all features on/off for this repo
/git-sync status     # show repo, branch, remote, dirty state, last sync
```

The features are **opt-in per repo**: while `.git-syncher.json` does not exist, the repo is left alone. `/git-sync` creates the file on first use and turns the features **on**; further uses flip its `enabled` flag.

### Config — `.git-syncher.json` (repo root)

```json
{
  "enabled": true,
  "pollingIntervalMinutes": 1,
  "debounceMinutes": 30,
  "postCommitPass": false
}
```

| Key                      | Default | Meaning                                                                                                   |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `enabled`                | `true`  | Master switch for both features (no per-feature toggles).                                                  |
| `pollingIntervalMinutes` | `1`     | Polling interval in minutes (must be > 0, capped at 1440).                                                 |
| `debounceMinutes`        | `30`    | Quiet time before the auto-commit window opens (must be > 0, capped at 1440). A host may pin it with `SyncerOptions.debounceMs`. |
| `postCommitPass`         | `false` | After a commit lands, hand the agent one bounded review pass over what it just committed (see below).       |

Keys this version does not read are reported once as a warning, so a setting left over from another tool cannot silently do nothing.

## Behavior details

- **Per repo, launched at the root.** All features activate only when pi's working directory IS the repo root: a session started in a subfolder stays fully dormant and never touches git (`/git-sync status` shows why). State (dirty clock) is in-memory per session; restarting pi mid-wait restarts the clock.
- **Change detection** is `git status --porcelain` plus the mtime of each dirty path, so repeated edits to the same file correctly restart the quiet window.
- **Never acts mid-turn.** Commit/push/pull only run while pi is idle; the dirty clock keeps tracking changes during an active turn, so a long agent run simply keeps the debounce alive.
- **Safe git.** Pulls are `--ff-only`. A diverged branch is never auto-merged: the syncher injects a session message asking the agent to resolve it (`git merge origin/<branch>`, conflicts included, then push) — once per divergence episode. While a merge is in progress, the syncher never auto-commits the conflicted state (a `MERGE_HEAD` guard). Detached HEAD and repos without an `origin` remote are left alone. If a push fails (e.g. network), the commit stays local and is pushed on a later poll.
- **Commit message:** written by the AI. When the debounce clock expires, the syncher stages the changes and sends a session message asking the idle agent to review `git diff --cached` and the repo's `git log` style, then call the `git_syncher_commit` tool with its message. The syncher performs the actual `git commit` + `git push` — the agent never runs git itself. At most one such request per quiet window (a failed agent turn retries quietly). The instruction also allows a bounded language pass and one companion file — only when the project's own instructions ask for them — declared through the tool's arguments. Hosts without an agent hook fall back to the fixed message `chore(git-syncher): auto-commit N file(s), <ISO timestamp>`.
- **The agent's seat in the commit.** `git_syncher_commit` takes two repo-relative path lists and does all the git work: `stage` adds files the agent reworked or created during its review pass (a language fix, a companion note), so they land in the very commit its message describes; `restoreStaged` drops paths that `git add -A` swept in but the project keeps out of history (a session log), leaving the files on disk. Both lists are an allowlist, not a shell: no git options, no wildcards, no absolute paths, no `..`, no `.` (that would re-add the whole tree), max 32 entries. A path an ignore rule covers is refused by `git add` itself, so gitignored content cannot be smuggled in. A rejected call commits nothing.
- **Post-commit pass** (`postCommitPass`, default off): once a commit lands, the agent gets one bounded follow-up turn to review what just landed, for projects whose instructions ask for a review or reflection note. It may only add new files — never amend or revert the commit, never rewrite files it committed, never stage — so its output is committed by the next window under its own message. At most one pass per commit.
- **The config file does not dirty your repo.** When the syncer creates `.git-syncher.json` it adds it to the repo-local `.git/info/exclude`, so the config itself never triggers a commit. If you deliberately commit the config (e.g. to share settings), it is tracked normally and changes to it sync like any other file.
- **Notifications:** `committed & pushed: <subject>`, `pulled N new commit(s)`, `pushed N pending commit(s)`, plus one-time warnings (`no remote`, `no upstream`, `push failed`, `pull failed`, `diverged`).

## Development

```bash
npm install
npm test      # node --test: engine unit tests + extension wiring test (real git repos)
npm run check # tsc --noEmit
```

Layout: `syncer.ts` is the transport-agnostic engine (injected git runner, clock, idle check); `index.ts` wires it into pi (poll loop on `session_start`/`session_shutdown`, `/git-sync` command).
