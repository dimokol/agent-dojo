# worktree-hygiene

An audit you run at session start: free disk, worktrees whose PR is merged, worktrees with unfinished work, idle dependency folders, orphaned dev servers and (if Docker is installed) the Docker cache size. It proposes removals and never deletes on its own.

An optional hook goes further: once you turn on `auto_sweep`, it removes worktrees and branches whose work is already on the remote, at most once an hour, in the background.

## Install
```
claude plugin marketplace add dimokol/agent-dojo
claude plugin install worktree-hygiene@dimokol
```

Without the plugin system: copy `skills/worktree-hygiene/` into `~/.claude/skills/` (or your project's `.claude/skills/`) and put the options below in a `## worktree-hygiene config` block in CLAUDE.md.

Then ask for a "health check" or "audit worktrees".

## Config
| Option | Default | What it does |
| --- | --- | --- |
| `worktree_filter` | empty | Only audit worktrees whose path contains this text. Empty means every `git worktree list` entry. |
| `dev_server_pattern` | `next dev\|vite\|webpack\|node --watch\|nodemon` | Regex used to find orphaned dev servers. |

The skill reads the plugin option, then the CLAUDE.md block, then the default. It does not read environment variables.

## Automatic sweep (opt-in)

Each worktree carries its own `node_modules`: 1.3 GB per worktree in the Expo app this was built for. Agents that make a worktree per task leave them behind after the merge, and Spotlight, backups and disk all pay for each one. Its first run on that Mac removed 2 merged worktrees and 28 local branches that were already on the remote.

With `auto_sweep` on, `scripts/worktree-sweep.sh` runs at session start, returns at once and sweeps in the background, at most once an hour per scope. It removes a worktree only when all of these hold:

- `git status` is empty, untracked files included.
- Its HEAD is on a remote branch after a successful `git fetch` (pushed or merged).
- No process has its working directory inside it (`lsof`, or `/proc` on Linux).
- No file outside `node_modules` changed for `sweep_idle_min` minutes (default 120).
- Every ignored file is a build artifact (`node_modules`, `.next`, `dist` and so on) or also exists in the main checkout. A `.scratch` folder with files keeps the worktree.

It also deletes local branches that aren't checked out anywhere and whose tip is on a remote branch, except main, master, dev, develop and the remote's default branch. Dirty, unpushed or in-use work is never touched, and every decision goes to the log with a reason.

| Option | Env var (hand-wired setups) | Default | What it does |
| --- | --- | --- | --- |
| `auto_sweep` | `WORKTREE_SWEEP_AUTO` | false | Turns the hook on |
| `sweep_roots` | `WORKTREE_SWEEP_ROOTS` (comma list or JSON array) | empty | Folders searched 5 levels deep for repos. Empty: only the repo the session starts in |
| `sweep_idle_min` | `WORKTREE_SWEEP_IDLE_MIN` | 120 | Minutes a worktree must be untouched |
| | `WORKTREE_SWEEP_INTERVAL_MIN` | 60 | Minimum gap between hook runs |

See what it would do without changing anything: `bash scripts/worktree-sweep.sh --dry-run` from inside a repo. Log: `~/Library/Logs/worktree-sweep.log` on macOS, `$XDG_STATE_HOME/worktree-sweep/` on Linux, `%LOCALAPPDATA%\worktree-sweep\` on Windows.

Why a hook and not a scheduled job: macOS privacy rules hide `~/Documents` from launchd jobs, so a launchd sweep finds no repos there.

## Turn it off
`claude plugin disable worktree-hygiene@dimokol`

## Requirements
The audit is tested on macOS; its Linux code paths haven't been run on Linux yet. Needs `git`. Optional: `gh` (merged-PR lookup, falls back to `git branch --merged`) and `docker`.

The sweep needs bash and git 2.31+. Its tests (`bash tests/run.sh`) run on macOS and Linux in CI. On Windows it runs under Git Bash; there's no `lsof` there, so the in-use check relies on Windows refusing to delete files a process holds open.
