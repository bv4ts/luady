"""version, sysinfo and update-claude verbs."""
from __future__ import annotations

import os
import platform
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import __version__, common
from .common import CtlError

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

SEMVER = re.compile(r'([0-9]+\.[0-9]+\.[0-9]+)', re.ASCII)
UPDATE_TIMEOUT_SECONDS = 300.0
UPDATE_OUTPUT_MAX = 65536


def claude_version(ctx: 'Ctx') -> str | None:
    result = ctx.run([str(ctx.paths.claude_bin), '--version'], timeout=15.0)
    match = SEMVER.search(result.text) if result.code == 0 else None
    return match.group(1) if match else None


def tmux_version(ctx: 'Ctx') -> str | None:
    result = ctx.run(['tmux', '-V'], timeout=5.0)
    parts = result.text.split()
    return parts[1] if result.code == 0 and len(parts) >= 2 else None


def cmd_version(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    return {'kit': __version__, 'claude': claude_version(ctx), 'tmux': tmux_version(ctx),
            'python': platform.python_version()}


def _meminfo(path: Path) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in path.read_text(encoding='ascii', errors='replace').splitlines():
        key, _, rest = line.partition(':')
        fields = rest.split()
        if fields and fields[0].isdigit():
            values[key.strip()] = int(fields[0])
    return values


def cmd_sysinfo(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    proc = Path(ctx.proc_root)
    load = (proc / 'loadavg').read_text(encoding='ascii').split()
    memory = _meminfo(proc / 'meminfo')
    disk = os.statvfs('/')
    uptime = (proc / 'uptime').read_text(encoding='ascii').split()
    return {'load1': float(load[0]), 'load5': float(load[1]), 'mem_total_kb': memory.get('MemTotal', 0),
            'mem_avail_kb': memory.get('MemAvailable', 0), 'disk_free_kb': disk.f_bavail * disk.f_frsize // 1024,
            'disk_total_kb': disk.f_blocks * disk.f_frsize // 1024, 'uptime_s': int(float(uptime[0]))}


def cmd_update_claude(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    if not ctx.paths.claude_bin.exists():
        raise CtlError('not_found', f'claude is not installed at {ctx.paths.claude_bin}')
    before = claude_version(ctx)
    result = ctx.run([str(ctx.paths.claude_bin), 'update'], timeout=UPDATE_TIMEOUT_SECONDS)
    if result.timed_out:
        raise CtlError('timeout', f'claude update did not finish within {int(UPDATE_TIMEOUT_SECONDS)} s')
    output = (result.stdout + result.stderr)[:UPDATE_OUTPUT_MAX].decode('utf-8', 'replace')
    return {'before': before, 'after': claude_version(ctx), 'output': output}
