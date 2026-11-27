#!/usr/bin/env bash
# Lints the shell scripts under deploy/ and tests/integration/ with ShellCheck (Docker) and rejects CRLF line endings.
# Usage (Git Bash, repo root): bash tests/integration/lint.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

main() {
  local roots=() scripts=() s crlf root
  for s in deploy tests/integration; do [ -d "$s" ] && roots+=("$s"); done
  mapfile -t scripts < <(find "${roots[@]}" -type f \( -name '*.sh' -o -path 'tests/integration/fake-server/claude' \) \
    -not -path '*/node_modules/*' | sort)
  [ "${#scripts[@]}" -gt 0 ] || { echo "lint: no scripts found" >&2; exit 1; }
  crlf="$(grep -rlIP '\r' "${roots[@]}" --exclude-dir=node_modules 2>/dev/null || true)"
  [ -z "$crlf" ] || { printf 'lint: CRLF line endings in:\n%s\n' "$crlf" >&2; exit 1; }
  for s in "${scripts[@]}"; do bash -n "$s"; done
  root="$(pwd -W 2>/dev/null || pwd)"
  MSYS_NO_PATHCONV=1 docker run --rm --mount "type=bind,source=$root,target=/mnt,readonly" -w /mnt \
    koalaman/shellcheck:v0.11.0 -x -P SCRIPTDIR "${scripts[@]}"
  echo "lint OK (${#scripts[@]} scripts)"
}

main "$@"
