#!/bin/sh
# Luady pause check: PostToolUse, synchronous. Only built-ins run unless this pane has a pause flag.
# Inert by itself: without $HOME, the kit (hook file, lib) or python3 it exits 0 and prints nothing.
[ -n "${TMUX_PANE:-}" ] && [ -n "${HOME:-}" ] || exit 0
d="$HOME/.luady/pause"
set -- "$d"/*
[ -e "$1" ] || exit 0
t=${TMUX#*,}
f="$d/${t%%,*}-${TMUX_PANE#%}"
[ -e "$f" ] || exit 0
h="$HOME/.luady/hooks/luady_hook.py"
[ -f "$h" ] && [ -f "$HOME/.luady/lib/luady_kit/pause.py" ] && command -v python3 >/dev/null 2>&1 || exit 0
printf '%s' '{"continue": false, "stopReason": "Paused by the owner"}'
python3 "$h" --pause-hit "$f" >/dev/null 2>&1
exit 0
