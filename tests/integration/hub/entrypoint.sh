#!/usr/bin/env bash
# The hub machine's entrypoint (tests/integration/hub/Dockerfile). It forwards the published port 7411 to the hub's
# own loopback port and then waits: the specs start and stop the hub themselves (`luady start` through docker exec),
# so a restart never ends the container.
set -euo pipefail

main() {
  local port="${LUADY_IT_WEB_PORT:?set LUADY_IT_WEB_PORT to the port the browser uses}"
  socat "TCP-LISTEN:7411,fork,reuseaddr" "TCP:127.0.0.1:$port" &
  exec sleep infinity
}

main "$@"
