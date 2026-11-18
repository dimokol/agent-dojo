#!/bin/sh
# Copies the shared status line to a fixed folder and prints the statusLine setting to paste.
# A plugin can't set statusLine, and the plugin cache path changes with every version, so the
# files live outside it.
#
#   sh install.sh [target folder]     default: ~/.claude/scripts/shared-statusline
#
# Rerun it after a plugin update. The running server notices its file changed and restarts
# within a minute. Your config (~/.config/shared-statusline/config.json) is never touched.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-$HOME/.claude/scripts/shared-statusline}
mkdir -p "$DEST"
for f in "$HERE/client.sh" "$HERE/server.mjs" "$HERE/../scripts/pressure.sh"; do
  cp "$f" "$DEST/.$(basename "$f").new"
  mv -f "$DEST/.$(basename "$f").new" "$DEST/$(basename "$f")"
done
chmod +x "$DEST/client.sh" "$DEST/pressure.sh"
echo "Installed to $DEST"
echo "Add to settings.json (each Claude config dir you use):"
echo "  \"statusLine\": { \"type\": \"command\", \"command\": \"sh $DEST/client.sh\", \"padding\": 0 }"
CFG=${SHARED_STATUSLINE_CONFIG:-$HOME/.config/shared-statusline/config.json}
[ -f "$CFG" ] || echo "Optional layout: copy $HERE/examples/full.json to $CFG"
