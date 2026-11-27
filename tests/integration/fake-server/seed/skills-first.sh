#!/usr/bin/env bash
# Stand-in for another tool's UserPromptSubmit hook on the same server: proves foreign hooks survive and keep running.
set -euo pipefail
cat >/dev/null
mkdir -p "$HOME/.fake-claude"
printf '%s skills-first ran\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME/.fake-claude/skills-first.log"
