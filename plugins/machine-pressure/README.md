# machine-pressure

A gate refuses a second e2e or docker run, and any heavy command while CPU, memory, load or free disk is RED. A shared status line renders every Claude Code tab from one process, pressure row included.

## Install

    claude plugin marketplace add dimokol/agent-dojo
    claude plugin install machine-pressure@dimokol

Without the plugin system: add `hooks/heavy-op-gate.sh` as a `PreToolUse` hook (matcher `Bash`) in `settings.json`.

## Shared status line

Claude Code runs the statusLine command in every tab, every few seconds. A ccstatusline layout with a dozen widgets starts about 12 node processes per render. The shared status line renders every tab from one long-lived node process; each tab runs a small shell client that hands its status JSON over with curl.

Measured on a MacBook (8 cores, 16 GB) with the same two-line layout:

| | Per render, per tab | Machine-wide |
| --- | --- | --- |
| ccstatusline, 12 widgets | 0.9 to 1.4 s, 93 MB peak, 0.9 s CPU | nothing |
| shared status line | 10 to 40 ms, 4.6 MB peak (sh + curl) | one 60 MB node server |

With 9 tabs refreshing every 10 s, that's about 8 CPU-seconds saved per 10 seconds, and no burst of node processes on every refresh. The pressure row runs `pressure.sh` once per 4 s for all tabs instead of once per widget per tab.

Install (a plugin can't set statusLine, so the files go to a fixed folder):

    sh ~/.claude/plugins/cache/dimokol/machine-pressure/*/statusline/install.sh

It copies `client.sh`, `server.mjs` and `pressure.sh` to `~/.claude/scripts/shared-statusline/` (or the folder you pass) and prints the setting:

    { "statusLine": { "type": "command", "command": "sh ~/.claude/scripts/shared-statusline/client.sh", "padding": 0 } }

Rerun it after a plugin update; the server restarts within a minute when its file changes. The first render after a restart prints `statusline starting...` while the server comes up. It exits after 30 minutes without a request.

### Layout

`~/.config/shared-statusline/config.json` (or `$SHARED_STATUSLINE_CONFIG`), reread when it changes. Without it you get model, context, five-hour usage and reset, branch, and the pressure row. `statusline/examples/` has a full layout and the author's own.

    {
      "separator": " | ",
      "colors": { "separator": "gray" },
      "lines": [
        ["model", { "type": "context", "color": 59 }, "five-hour", "branch"],
        ["pressure"]
      ]
    }

Each line is a list of segments: a name, or `{ "type", "color", "fallback" }`. Colors are 256-color numbers or `black red green yellow blue magenta cyan white gray`. `fallback` is shown when the segment is empty.

| Segment | Shows |
| --- | --- |
| `model` | Model name |
| `agent-chat` | This session's [agent-chat](../agent-chat) name, when agent-chat is installed (or set `agentChatModule` to its `statusline-name.mjs`) |
| `effort` | Reasoning effort |
| `context` | Tokens in the context window |
| `session-tokens` | All tokens this session used, read from the transcript incrementally |
| `five-hour`, `five-hour-reset` | Five-hour usage % and time to reset |
| `week`, `week-reset` | Weekly usage % and time to reset |
| `branch` | Git branch, read from `.git/HEAD` (no git process) |
| `dir` | Folder name |
| `cost` | Session cost in USD |
| `pressure` | CPU, RAM, swap, load, free disk and the pressure level, colored like the gate sees them |
| `text` | `{ "type": "text", "text": "..." }` |

`"loadLog": true` (or `SHARED_STATUSLINE_LOAD_LOG=1`) appends one machine sample per 10 s, load, swap, free memory and the top 5 processes, to `~/Library/Logs/machine-load.log` (macOS), `$XDG_STATE_HOME/shared-statusline/` (Linux) or `%LOCALAPPDATA%\shared-statusline\` (Windows). It's capped at 5 MB plus one older file. Off by default.

How it talks: a unix socket at `~/.cache/shared-statusline/sock` (mode 0600) on macOS and Linux. On Windows node can't listen on a socket file, so the server takes a random loopback port and writes it with a random token to `~/.cache/shared-statusline/endpoint`; the client sends the token. Windows has no load average, so the pressure row there shows CPU, RAM and disk, read inside the server.

### Other ways to show pressure

`pressure.sh` alone works as a statusLine too: copy `scripts/pressure.sh` and point `statusLine` at `pressure.sh --statusline`. Other modes: `--json` has the plain values for scripts (`"level":"AMBER"`, `"ram_pct":71`). `--field cpu|ram|swap|load|disk|level` prints one colored segment such as `RAM 71%` or `pressure AMBER`; `--segments` prints all six in one run. Set `NO_COLOR=1` to drop the color codes. Level is OK, AMBER, RED, or UNKNOWN when nothing can be read (never RED). Readings are cached 4 seconds per folder.

For [ccstatusline](https://www.npmjs.com/package/ccstatusline), add custom-command widgets (all six: `examples/ccstatusline.json`). Each is `{ "type": "custom-command", "commandPath": "~/.claude/scripts/pressure.sh --field ram", "preserveColors": true, "timeout": 2500 }`. If a widget stays empty, write the full home path instead of `~`.

## Config

| Option | Env var | Default | What it does |
| --- | --- | --- | --- |
| `cpu_amber`, `cpu_red` | `MACHINE_PRESSURE_CPU_AMBER`, `_CPU_RED` | 85, 97 | CPU % of all cores |
| `ram_amber`, `ram_red` | `MACHINE_PRESSURE_RAM_AMBER`, `_RAM_RED` | 85, 93 | RAM in use, %. On macOS the kernel's memory pressure also counts: warn is AMBER, critical is RED |
| `swap_amber`, `swap_red` | `MACHINE_PRESSURE_SWAP_AMBER`, `_SWAP_RED` | 70, 90 | Swap in use, %, Linux only. macOS keeps pages in swap long after the pressure is gone, so there swap is shown without a color and never sets the level |
| `disk_amber_gb`, `disk_red_gb` | `MACHINE_PRESSURE_DISK_AMBER_GB`, `_DISK_RED_GB` | 20, 10 | Free GB on the disk that holds the current folder. On Linux a folder on tmpfs (often `/tmp`) is memory, so the disk of `$HOME` counts instead |
| `load_amber_x`, `load_red_x` | `MACHINE_PRESSURE_LOAD_AMBER_X`, `_LOAD_RED_X` | 1.5, 3 | 1-min load, times core count |
| `max_parallel_heavy` | `MACHINE_PRESSURE_MAX_PARALLEL_HEAVY` | 1 | Concurrent e2e or docker runs |
| `extra_heavy_patterns` | `MACHINE_PRESSURE_EXTRA_HEAVY_PATTERNS` | none | Regexes (comma separated in the env var) for more gated commands |
| `ignore_running_patterns` | `MACHINE_PRESSURE_IGNORE_RUNNING_PATTERNS` | none | Regexes for running processes that don't count toward `max_parallel_heavy`. An invalid one is skipped with a note |

Each setting comes from the plugin option, then the env var (`settings.json` `env`; the statusline script reads only that), then the default. Gated: installs, builds and test runners (npm, pnpm, yarn, bun, workspace forms, pytest, cargo, go, turbo, make, mvn, gradle), e2e (playwright, cypress, `test:e2e*`, an `e2e` or `e2e:*` script), docker run/build and compose up/build/run/start. Anything else: `extra_heavy_patterns`. Compose commands that don't start containers (`exec`, `logs`, `down`), `e2e:down`, package queries such as `npm ls jest` and quoted text never match. To run one command anyway, put `PRESSURE_ALLOW=1` directly before it, after any `cd`: `cd app && PRESSURE_ALLOW=1 npm run build`. An attached long-running `docker run` (an `-it` shell) holds the docker slot until it exits. A `docker run -i` without a tty is a stdio MCP server and never counts.

## Turn it off

    claude plugin disable machine-pressure@dimokol

## Requirements

Tests pass on macOS and Linux in CI, and day-to-day use so far is on macOS. The shared status line needs node 18.15+ and curl; on Windows it runs under Git Bash. Needs `sh`, `awk`, and `jq` for the gate (without jq it allows everything and says so once). Other systems report UNKNOWN. Where `ps` lacks `-A -o pid=,ppid=,command=` (busybox), the parallel cap does nothing.
