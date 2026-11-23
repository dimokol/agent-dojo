#!/bin/sh
# Copies the shared status line to a fixed folder and prints the statusLine setting, or writes it.
# A plugin can't set statusLine, and the plugin cache path changes with every version, so the
# files live outside it.
#
#   sh install.sh [target folder] [--settings <claude config dir>]...
#
# Default folder: ~/.claude-shared/tools/shared-statusline when ~/.claude-shared exists (one copy
# for several Claude config dirs), else ~/.claude/scripts/shared-statusline.
# --settings writes the same statusLine into <dir>/settings.json (a .bak copy first), once per
# profile: --settings ~/.claude-dimo --settings ~/.claude-2. Needs node. Without it, the setting is
# only printed.
#
# Rerun it after a plugin update. The running server notices its file changed and restarts
# within a minute. Your config (~/.config/shared-statusline/config.json) is never touched.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=""
SETTINGS=""
while [ $# -gt 0 ]; do
  case $1 in
    --settings) [ $# -ge 2 ] || { echo "--settings needs a folder" >&2; exit 2; }
                SETTINGS="$SETTINGS
$2"; shift 2 ;;
    *) DEST=$1; shift ;;
  esac
done
if [ -z "$DEST" ]; then
  if [ -d "$HOME/.claude-shared" ]; then DEST=$HOME/.claude-shared/tools/shared-statusline
  else DEST=$HOME/.claude/scripts/shared-statusline; fi
fi
mkdir -p "$DEST"
for f in "$HERE/client.sh" "$HERE/server.mjs" "$HERE/../scripts/pressure.sh"; do
  cp "$f" "$DEST/.$(basename "$f").new"
  mv -f "$DEST/.$(basename "$f").new" "$DEST/$(basename "$f")"
done
chmod +x "$DEST/client.sh" "$DEST/pressure.sh"
# The example layouts go along, so the layout hint below points at a copy that stays.
mkdir -p "$DEST/examples" && cp "$HERE"/examples/*.json "$DEST/examples/"
# Windows (Git Bash): settings.json needs a path Claude Code can hand to sh, C:/Users/..., not /c/...
SHOW=$DEST; command -v cygpath >/dev/null 2>&1 && SHOW=$(cygpath -m "$DEST")
CMD="sh $SHOW/client.sh"
echo "Installed to $SHOW"

if [ -n "$SETTINGS" ]; then
  echo "$SETTINGS" | while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    f=$dir/settings.json
    node -e '
      const fs = require("fs"), [f, cmd] = process.argv.slice(1)
      let s = {}
      if (fs.existsSync(f)) { fs.copyFileSync(f, f + ".bak"); s = JSON.parse(fs.readFileSync(f, "utf8")) }
      s.statusLine = { type: "command", command: cmd, padding: 0, refreshInterval: 10 }
      fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n")
    ' "$f" "$CMD"
    echo "statusLine written to $f"
  done
else
  echo "Add to settings.json (each Claude config dir you use), or rerun with --settings <dir>:"
  echo "  \"statusLine\": { \"type\": \"command\", \"command\": \"$CMD\", \"padding\": 0, \"refreshInterval\": 10 }"
fi
CFG=${SHARED_STATUSLINE_CONFIG:-$HOME/.config/shared-statusline/config.json}
if [ ! -f "$CFG" ]; then
  SRC=$DEST/examples/full.json; TO=$CFG
  command -v cygpath >/dev/null 2>&1 && { SRC=$(cygpath -m "$SRC"); TO=$(cygpath -m "$CFG"); }
  echo "Optional layout: copy $SRC to $TO"
fi
