#!/bin/sh
# Builds agent-chat-win.exe (x86-64 Windows 10+) from agent-chat-win.c with mingw-w64 and prints
# its SHA-256, which goes into agent-chat-win.sha256 next to it. Run from anywhere:
#   sh plugins/agent-chat/server/build-win.sh
# --no-insert-timestamp keeps the bytes the same for the same source and compiler.
set -eu
cd "$(dirname "$0")"
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -municode -s -static-libgcc \
  -Wl,--no-insert-timestamp -o agent-chat-win.exe agent-chat-win.c -ladvapi32
sum=$(shasum -a 256 agent-chat-win.exe | cut -d' ' -f1)
printf '%s  agent-chat-win.exe\n' "$sum" > agent-chat-win.sha256
ls -l agent-chat-win.exe
cat agent-chat-win.sha256
