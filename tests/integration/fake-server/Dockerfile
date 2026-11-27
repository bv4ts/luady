# syntax=docker/dockerfile:1
# Fake fleet server for the Luady integration tests:
# - Ubuntu 24.04 with sshd, tmux, python3 and git, and the user dev;
# - fake-claude at ~/.local/bin/claude and cedar's foreign hook;
# - in stage with-kit, the real server kit installed with install.py --host-alias cedar.
FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server tmux python3 git procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && printf 'LANG=C.UTF-8\n' > /etc/default/locale \
 && useradd --create-home --shell /bin/bash dev \
 && usermod --password '*' dev
COPY sshd-luady-it.conf /etc/ssh/sshd_config.d/10-luady-it.conf
COPY entrypoint.sh /usr/local/sbin/luady-it-entrypoint
COPY fake_claude.py spool_dump.py smoke.py /opt/fake-claude/
COPY --chown=dev:dev claude /home/dev/.local/bin/claude
COPY --chown=dev:dev seed/settings.json /home/dev/.claude/settings.json
COPY --chown=dev:dev seed/skills-first.sh /home/dev/.claude/hooks/skills-first.sh
COPY --chown=dev:dev seed/trusted.json /home/dev/.fake-claude/trusted.json
RUN chmod 0755 /usr/local/sbin/luady-it-entrypoint /home/dev/.local/bin/claude /home/dev/.claude/hooks/skills-first.sh \
 && chmod 0644 /opt/fake-claude/fake_claude.py /opt/fake-claude/spool_dump.py /opt/fake-claude/smoke.py \
 && python3 -m py_compile /opt/fake-claude/fake_claude.py /opt/fake-claude/spool_dump.py /opt/fake-claude/smoke.py \
 && install -d -m 0755 /home/dev/projects /home/dev/projects/alpha /home/dev/projects/beta \
      /home/dev/projects/gamma /home/dev/projects/fresh /home/dev/projects/e2e \
 && chown -R dev:dev /home/dev
ENTRYPOINT ["/usr/local/sbin/luady-it-entrypoint"]

FROM base AS with-kit
COPY --from=serverkit --chown=dev:dev . /tmp/server-kit
RUN su - dev -c 'cd /tmp/server-kit && python3 install.py --host-alias cedar' > /var/log/luady-kit-install.json \
 && rm -rf /tmp/server-kit \
 && test -x /home/dev/.luady/bin/luady-ctl \
 && test -f /home/dev/.luady/hooks/luady_hook.py \
 && test -f /home/dev/.luady/hooks/luady_step.py \
 && test -f /home/dev/.luady/hooks/luady_pause.sh \
 && test -f /home/dev/.luady/hooks/luady_statusline.py \
 && grep -q '"steps": "on"' /var/log/luady-kit-install.json
