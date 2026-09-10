# pi-git-syncher

A [pi](https://pi.dev) coding-agent extension that keeps your git repo in sync while you (or the agent) work:

- **Automatic commit & push** — polls the repo on an interval. When the working tree is dirty, a 30-minute debounce clock starts; any new change restarts it. Once the tree has been quiet for 30 minutes, it runs `git add -A`, commits, and pushes.
- **Automatic retrieving** — on each poll, if the working tree is clean and the remote has new commits, it runs `git pull --ff-only`.
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
  "pollingIntervalMinutes": 1
}
```

| Key                      | Default | Meaning                                                    |
| ------------------------ | ------- | ---------------------------------------------------------- |
| `enabled`                | `true`  | Master switch for both features (no per-feature toggles).  |
| `pollingIntervalMinutes` | `1`     | Polling interval in minutes (must be > 0, capped at 1440). |

The 30-minute debounce is fixed by design.

## Behavior details

- **Per repo, keyed by the repo root.** The synced repo is the toplevel of pi's working directory; state (dirty clock) is in-memory per session. If pi restarts mid-wait, the clock restarts from the next poll.
- **Change detection** is `git status --porcelain` plus the mtime of each dirty path, so repeated edits to the same file correctly restart the 30-minute wait.
- **Never acts mid-turn.** Commit/push/pull only run while pi is idle; the dirty clock keeps tracking changes during an active turn, so a long agent run simply keeps the debounce alive.
- **Safe git.** Pulls are `--ff-only` — a diverged branch is never auto-merged; you get a one-time warning instead. Detached HEAD and repos without an `origin` remote are left alone. If a push fails (e.g. network), the commit stays local and is pushed on a later poll.
- **Commit message:** `chore(git-syncher): auto-commit N file(s), <ISO timestamp>`.
- **The config file does not dirty your repo.** When the syncer creates `.git-syncher.json` it adds it to the repo-local `.git/info/exclude`, so the config itself never triggers a commit. If you deliberately commit the config (e.g. to share settings), it is tracked normally and changes to it sync like any other file.
- **Notifications:** `committed & pushed N file(s)`, `pulled N new commit(s)`, `pushed N pending commit(s)`, plus one-time warnings (`no remote`, `no upstream`, `push failed`, `pull failed`, `diverged`).

## Development

```bash
npm install
npm test      # node --test: engine unit tests + extension wiring test (real git repos)
npm run check # tsc --noEmit
```

Layout: `syncer.ts` is the transport-agnostic engine (injected git runner, clock, idle check); `index.ts` wires it into pi (poll loop on `session_start`/`session_shutdown`, `/git-sync` command).
