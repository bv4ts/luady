# syntax=docker/dockerfile:1
# The hub machine for the end-to-end specs that run the real `luady start`: Linux with Node 22, tmux and Python 3
# (and a compiler for the native modules), one user (`owner`) with this checkout installed and built in ~/luady, and
# the fake Claude Code at ~/.local/bin/claude (the default claudePath). Built from the repository root:
#   docker compose -f tests/integration/docker-compose.yml --profile hub build hub
# The hub listens on 127.0.0.1 inside; socat forwards the published port to it, so the hub sees a loopback peer and
# the browser's Host and Origin are localhost:<port>, as on the owner's own machine.
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux python3 socat procps ca-certificates git make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash owner \
 && install -d -o owner -g owner /home/owner/luady /home/owner/.local /home/owner/.local/bin /opt/fake-claude
USER owner
WORKDIR /home/owner/luady
# The install first, from the lockfile and the workspace manifests only, so a source change keeps this layer.
COPY --chown=owner:owner package.json package-lock.json ./
COPY --chown=owner:owner packages/addon-sdk/package.json packages/addon-sdk/
COPY --chown=owner:owner packages/hub/package.json packages/hub/
COPY --chown=owner:owner packages/mcp/package.json packages/mcp/
COPY --chown=owner:owner packages/office/package.json packages/office/
COPY --chown=owner:owner packages/shared/package.json packages/shared/
COPY --chown=owner:owner packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY --chown=owner:owner . ./
RUN npm run build
COPY --chown=owner:owner tests/integration/fake-server/fake_claude.py /opt/fake-claude/fake_claude.py
COPY --chown=owner:owner --chmod=0755 tests/integration/fake-server/claude /home/owner/.local/bin/claude
COPY --chmod=0755 tests/integration/hub/entrypoint.sh /usr/local/bin/luady-it-hub
ENTRYPOINT ["/usr/local/bin/luady-it-hub"]
