# Disposable "VPS-like" image for the deploy-script tests: Ubuntu 24.04 with the tools the VPS has,
# plus systemd for systemd-analyze (never started). Node 22.22.0 comes from the official image.
FROM node:22.22.0-bookworm-slim AS node

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl gnupg openssl sudo python3 tmux \
      xz-utils tzdata systemd procps openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version
