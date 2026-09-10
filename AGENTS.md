# Promot
This repo is codebase for a pi coding agent extension. 

## The features of Pi Git Syncher

Automatic commit & push
- When the repo is dirty. Wait for some time(30 minutes?). 
- If there is no additional change after dirty flag is on, do git add, commit & push. 

Automatic retrieving
- Periodically check the remote repo is changed, if is changed, do `git pull`. 
- If local repo is changed, don't need to do it. Automatic commit & push feature would handle it. 

Minimize interfere with user or tool actions. Do it silently. 
