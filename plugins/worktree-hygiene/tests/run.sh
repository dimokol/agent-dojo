#!/bin/sh
# Runs every worktree-hygiene test. Needs bash and git.
HERE=$(cd "$(dirname "$0")" && pwd)
bash "$HERE/sweep.sh"
