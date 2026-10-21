# storage-reclaim

Frees disk space on a Mac without deleting what a dev server, a test run or another agent session is using. Built for running several Claude Code or Codex sessions with worktrees, where a folder that looks idle often isn't.

## Install

```
claude plugin marketplace add dimokol/agent-dojo
claude plugin install storage-reclaim@dimokol
```

Then ask your agent to "free up space". For a better scan, `brew install dua-cli` first.

Codex or without the plugin system: `npx skills add dimokol/agent-dojo` (every skill in the repo), or copy both folders under `skills/` into your skills folder; scan.sh expects disk-map next to it.

## What you get

A table first, so you can act in a minute and stop:

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

Reply `rec`, or the IDs you want. The agent deletes those, then shows free space before and after. Details follow the table for anyone who wants them: worktrees, projects, what grew since the last run, the system side, and files that may be the only copy.

What keeps it safe:
- **In use.** Anything a process has open or runs inside is held back, and so is a project a command line names (`python app1/server.py` from the parent folder).
- **Other sessions.** Locked worktrees, lock folders and session worktree folders are never proposed.
- **Idle means idle.** A project's installs only go when it has had no commit, edit or Claude Code or Codex session for 7 days.
- **Worktrees.** Proposed only when clean, on origin or merged (squash merges too, with `gh`), and their `.env`, local databases and other ignored files match the main checkout. `git worktree remove` is never forced.
- **Content.** Archives, installers, anything git tracks, generic `build`/`dist` folders outside git, and folders holding a git checkout never get an ID.
- **Your call.** Nothing is deleted without your reply. Keep-lists in `~/.config/storage-reclaim/` remember what you said to keep.

disk-map, bundled, is the read-only part: a treemap page and a text summary for any folder or drive, on macOS, Linux or Windows, plus a diff of what grew between two scans. Ask "what's taking space on my external drive".

The map files (`~/.local/state/storage-reclaim/*.html`, `*.stacks`) list every folder name in your home folder. Don't share them.

## Config

| Option | Default | What it does |
| --- | --- | --- |
| `project_roots` | ~/Documents, ~/Projects, ~/code, ~/Developer, ~/src (those that exist) | Colon-separated folders that hold your repos |
| `idle_days` | 7 | Days without a commit, edit or agent session before a project counts as idle |
| `lock_dir` | empty | Folder name your sessions use to mark active work. A project holding a lock is left alone. |
| `worktree_suffix` | empty | Folders ending in this hold other sessions' worktrees and are left alone |

Set them with `/plugin configure storage-reclaim@dimokol`. Without the plugin system, put them in a `## storage-reclaim config` block in CLAUDE.md, or set `STORAGE_RECLAIM_PROJECT_ROOTS` and the like when you run `scripts/scan.sh` yourself.

## Turn it off

`claude plugin disable storage-reclaim@dimokol`

## Requirements

macOS, zsh, `lsof`, python3. `dua` 2.43 or newer for the map and the what-grew diff; without it sizes come from `du`, which is slower. `gh` is optional, for squash-merged worktrees. Tests: `bash tests/run.sh` (macOS) and `bash tests/disk-map.sh` (macOS and Linux).
