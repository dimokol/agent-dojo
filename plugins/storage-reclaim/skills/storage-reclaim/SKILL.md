---
name: storage-reclaim
description: Free disk space on macOS without deleting anything a process or another agent session is using, or the only copy of something. Leads with a ranked table of quick wins and a one-word "rec" option. Use when "free up space", "clean up my disk", "disk is full", "what's eating my disk", "reclaim space", a build or install fails for lack of space, or the disk turns red. Also good as a monthly sweep.
---

# storage-reclaim

A cleanup goes wrong in two ways. It deletes something in use, like a `node_modules` under a running test suite, or a worktree another session is working in. Or it deletes the only copy of something: an archive that looks extracted but never was, or a "duplicate" repo that is a fork with unpushed commits. The scan checks for both before it proposes anything.

Needs zsh, `lsof` and python3; tested on macOS. `dua` (`brew install dua-cli`, 2.43 or newer) makes it faster and adds the what-grew diff. disk-map, next to this skill, draws the map.

## Config

A value that still reads as a literal `${...}` or is blank means unset.

| Option | Plugin option | Env var for scan.sh | Default |
|---|---|---|---|
| `project_roots` | `${user_config.project_roots}` | `STORAGE_RECLAIM_PROJECT_ROOTS` | whichever of ~/Documents, ~/Projects, ~/code, ~/Developer, ~/src exist |
| `idle_days` | `${user_config.idle_days}` | `STORAGE_RECLAIM_IDLE_DAYS` | 7 |
| `lock_dir` | `${user_config.lock_dir}` | `STORAGE_RECLAIM_LOCK_DIR` | empty, skip |
| `worktree_suffix` | `${user_config.worktree_suffix}` | `STORAGE_RECLAIM_WORKTREE_SUFFIX` | empty, skip |

Without the plugin, read the same keys from a `## storage-reclaim config` block in CLAUDE.md. Pass set values to scan.sh as env vars on the same command line. `project_roots` is colon-separated.

Keep-lists live in `~/.config/storage-reclaim/` (copied from the templates here on the first run, so plugin updates don't wipe them):
- `never-touch.txt`: paths no cleanup proposes. When the user says "keep X", add a line.
- `decisions.tsv`: what the user decided on past runs. `keep` and `user handles` hold an item until its recheck date. Append today's decisions at the end of every run.

## 1. Scan

```bash
zsh <this skill's folder>/scripts/scan.sh
```

It's read-only and takes about a minute. It writes only its snapshots (`~/.local/state/storage-reclaim/`) and the keep-lists on the first run. Never run `dua flamegraph`: it opens the user's browser and can't write to a file.

If the user needs room for something specific, ask how much first. When the top rows cover it, stop there.

## 2. Show the table

Show the QUICK WINS block exactly as printed, from its first line through the `held:` line, and nothing else from the scan unless asked. It looks like this:

```
QUICK WINS · 38.2 GB free
ID      GB  back      what
Q1     6.1  rebuild   ~/code/app: node_modules, .next (idle, last commit 40 d)
Q2     3.2  regrows   ~/Library/Caches/Homebrew
Q3     1.4  git       worktree ~/code/app-wt/fix-login (merged, clean)
Q4     0.6  none      2 old claude CLI versions
back: none = junk · regrows = on its own · rebuild = install/build · download = on next use · git = from origin
rec = Q1 Q2 Q3 Q4 · 38.2 → ~49.5 GB free
held: 3 in use · 1 never-touch
```

The user replies `rec`, a list of IDs, or asks for more. The details below the table (worktrees, projects, what grew, system side, needs a look, held back) are for you. Use them to answer questions.

What the scan already decided, so you don't redo it:
- **In use**: a process has a file open under the path, runs in a folder above it inside the same project, or names the project on its command line (`python app1/server.py` from the parent folder counts for app1). A process started above the project with no path arguments (`npm --workspaces run dev` from a folder that isn't one git repo) isn't seen; the delete-time re-check below is the backstop. Those, never-touch paths, kept decisions, lock-file trees and locked worktrees never reach the table.
- **Idle project**: no commit, no file edit and no Claude Code or Codex session there for `idle_days`, and nothing running in it. Idle projects lose their installs and build output; active ones only build output that regrows.
- **Only what git ignores**: a tracked `dist/` or `build/` is content and never listed. Outside git, only unambiguous names (`node_modules`, `.venv`, `.next` and the like) are; `build`, `dist`, `out` and `vendor` may be the only copy. A folder holding a git checkout (pip `-e` sources in `.venv/src`) is held.
- **Worktree rows (git)**: clean, not in use or locked, on origin or merged per `git ls-remote` (a squash merge counts when `gh` finds a merged PR whose head is this commit), and every ignored file except provable build output (`.env`, `.data/`, `dist/`) is identical to the main checkout's copy. Origin unreachable means no git row.
- **rec**: every Q row except rebuild rows of active projects and worktrees with a recent session. Never R rows.

## 3. Delete

Only what the user approved. If the table is more than about an hour old, scan again first. Right before deleting, re-check each row and skip and name anything that changed:
- In use: `lsof +D <path>` on small folders; for big trees, `lsof -a -d cwd` plus a `grep` of `ps -axo command` for the path and its project.
- Idle rows: no new commit, edit or agent session in the project since the scan.
- Worktree rows: still clean (`git status --porcelain --ignored`), nothing unpushed, local-only files still identical to the main checkout.
- If `git worktree remove` refuses, skip the row and say why. Never add `--force`.

- Run the command from the ACTIONS section at the end of the scan for each ID. Print each path with the size it freed.
- R rows: give the user the exact `sudo` command to paste into Terminal.app. The `!` prefix can't answer a password prompt.
- `rm -rf` can stop partway through a tree without write permission. Run `chmod -R u+w` and finish, or report the folder as still there.
- Measure free space with `df` on the volume the scan names (`/System/Volumes/Data` on macOS) before and after, and print it next to the scan's estimate. Clones, hardlinks and growing swap make the two differ. Say by how much.

Close with what the user needs to know: projects that need an install or a build before they run, what downloads again on first use, and what you kept and why. Record today's decisions in `decisions.tsv`.

## Content checks (needs a look)

Items that may hold the only copy of something never get a Q ID. They're listed under NEEDS A LOOK. One check each before proposing them:

| Looks like | Check |
|---|---|
| An archive next to a folder of the same name | Compare `unzip -l` with the folder. Transfer links expire. |
| A `.dmg` or `.pkg` | Is the app in /Applications? |
| A second copy of a repo or toolchain | `git status`, and `git log --branches --not --remotes` for unpushed commits |
| Anything in Downloads, Documents or Desktop | The user's content: ask, whatever the size |
| A VM image or container volume | Does it hold state, or is it a rebuildable base image? |

When a check is ambiguous, keep the item and say why.

## Traps the scan flags

- **Simulator runtimes an Xcode update dropped from the asset catalogue** (`/System/Library/AssetsV2/*/…xml`). Deleting one with `simctl` or Xcode unlists it, but its `.asset` folder stays and System Integrity Protection blocks `sudo rm`. Only Recovery mode frees it. Say so before deleting such a runtime.
- **Browser profiles in `~/Library/Caches`** (Playwright MCP profiles and the like) hold logins. Only `Cache`, `Code Cache`, `GPUCache` and `GrShaderCache` inside a closed profile may go.
- **pnpm stores** are hardlinked into projects: `pnpm store prune`, never `rm`.
- **`~/.cache`** mixes caches with app data. Judge each subfolder.
- **Swap** shares the disk and returns when apps close.
- **Privacy**: the map's `.html` and `.stacks` files list every folder name in the home folder. Don't attach them anywhere.
