# Demo

The GIF at the top of the main README is recorded from this folder with
[VHS](https://github.com/charmbracelet/vhs): run `vhs demo.tape`. It needs `node` and `jq`.

It runs the plugins' real hooks and the real agent-chat server inside a throwaway folder. Scene 2's
two agents are scripted MCP clients, so they use `wait`; real Claude Code and Codex sessions are
woken by the post instead. Scene 1's
CPU, memory and disk numbers come from the stub system tools in `fixtures/red-machine`, so every
machine records the same RED state.
