# Pi Git Syncher
This repo is codebase for a pi coding agent extension. 

## The features of Pi Git Syncher

Automatic commit & push
- Check git status every 1 minute (polling interval).
- When the repo is dirty, set a dirty flag and wait (debounce time: 30 minutes).
- If there is no additional change after the dirty flag is on, do git add, commit & push.
- Any new change restarts the 30-minute wait.

Automatic retrieving
- Check the remote repo is changed every 1 minute, if is changed, do `git pull`. 
- If local repo is changed, don't need to do it. Automatic commit & push feature would handle it. 

Minimize interfere with user or tool actions. Do it silently. 

## Slash(/) commands
`/git-sync`
- Toggles the whole features on & off for this repo (no per-feature toggles).
- Works per repo: active in any repo having git configuration, keyed by the config file in the repo root.

Config file `.git-syncher.json` in the repo root (cwd). `/git-sync` generates it if missing.
Config has following attributes
- on or off activating the features. (default on, but only while the config file exists — without it the features are off)
- Polling interval. (default 1 minute)
