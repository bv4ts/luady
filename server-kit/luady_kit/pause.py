"""Pause and resume a Claude session through a per-pane flag (kit 2).

- `luady-ctl pause` writes ~/.luady/pause/<tmux server pid>-<pane number>. The tmux server pid is part of the name,
  so a flag left over from an old tmux server can never match a new pane.
- hooks/luady_pause.sh, a synchronous PostToolUse check, prints the stop line when its own pane
  has a flag and then runs `luady_hook.py --pause-hit <flag>` (hit_main): mark the flag hit, spool `paused`.
- `luady-ctl resume` removes the flag and, only when the pause had really stopped the session, types RESUME_TEXT.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO, Iterator

from . import common, hook
from .common import CtlError
from .tmuxio import (TARGET_FORMAT, Tmux, _require_claude, _require_pane, exact, is_claude_pane, pending_qid_for,
                     send_text)

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

STOP_OUTPUT = '{"continue": false, "stopReason": "Paused by the owner"}'
# The model refused "Resume. Continue from where you paused."; this wording resumed the work.
RESUME_TEXT = 'The owner has lifted the pause. Continue from where you paused.'
FLAG_MAX_AGE_SECONDS = 7 * 86400
FLAG_NAME_RE = re.compile(r'([0-9]{1,10})-([0-9]{1,10})', re.ASCII)
PANE_IDS_FORMAT = '#{pid}\t#{pane_id}'
LOCK_NAME = '.lock'  # a dot file: the shell check's `"$d"/*` never sees it
# A stop printed after a failed tool call does not stop the session.
NOT_A_STOP_EVENT = 'PostToolUseFailure'
RESUME_AFTER_HIT_SECONDS = 2.0  # time for Claude Code to end the stopped turn before the resume text is typed


def flag_name(server_pid: str, pane_id: str) -> str:
    """'<server_pid>-<pane id without %>', e.g. '4242-7'."""
    return f'{server_pid}-{pane_id.lstrip("%")}'


def flag_path_for(paths: common.KitPaths, tmux: Tmux, target: str) -> Path | None:
    """The flag path of the pane at exactly `target` (one tmux call), or None when there is no such pane. tmux would
    resolve a missing pane index to the active pane, so the target it reports back must match."""
    text = tmux.display(exact(target), PANE_IDS_FORMAT + '\t' + TARGET_FORMAT)
    server_pid, pane_id, shown = ((text or '').split('\t') + ['', '', ''])[:3]
    name = flag_name(server_pid, pane_id)
    return paths.pause / name if FLAG_NAME_RE.fullmatch(name) and shown == target else None


def live_target(tmux: Tmux, path: Path) -> str | None:
    """The target of the pane a flag is keyed to (server pid + pane id), whatever the target was when it was set."""
    server_pid, pane_number = path.name.split('-', 1)
    text = tmux.display(f'%{pane_number}', '#{pid}\t' + TARGET_FORMAT)
    pid, _, target = (text or '').partition('\t')
    return target if pid == server_pid and common.matches(common.TARGET_RE, target) else None


@contextlib.contextmanager
def _locked(paths: common.KitPaths) -> Iterator[None]:
    """Serialises resume and hit, so a hit never brings back a flag that resume just removed."""
    paths.pause.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(paths.pause / LOCK_NAME, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _flag_files(paths: common.KitPaths) -> list[Path]:
    try:
        names = os.listdir(paths.pause)
    except OSError:
        return []
    return [paths.pause / name for name in sorted(names) if FLAG_NAME_RE.fullmatch(name)]


def _flag_target(path: Path) -> str | None:
    entry = common.read_json_or_none(path)
    target = entry.get('target') if isinstance(entry, dict) else None
    return target if common.matches(common.TARGET_RE, target) else None


def paused_targets(paths: common.KitPaths, tmux: Tmux | None = None) -> set[str]:
    """The targets of the paused panes. With tmux, each flag's pane (by server pid and pane id) is looked up live, so
    a renumbered pane is reported at its new target and a flag of another tmux server not at all."""
    targets = set()
    for path in _flag_files(paths):
        target = _flag_target(path) if tmux is None else live_target(tmux, path)
        if target is not None:
            targets.add(target)
    return targets


def cmd_pause(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    tmux = Tmux(ctx.run)
    _require_claude(_require_pane(tmux, ns.target), ctx)
    path = flag_path_for(ctx.paths, tmux, ns.target)
    if path is None:
        raise CtlError('failed', f'tmux did not report the ids of pane {ns.target}')
    common.ensure_runtime_dirs(ctx.paths)
    server_start = common.proc_start_ticks(int(path.name.split('-', 1)[0]), ctx.proc_root)
    common.exclusive_write_json(path, {'target': ns.target, 'at': common.iso_utc(ctx.now()), 'hit': False,
                                       'server_start': server_start})
    return {'ok': True, 'paused': True}


def _remove_flags(flags: list[Path]) -> bool:
    """Remove the flags; True when one of them had stopped the session."""
    was_hit = False
    for path in flags:
        entry = common.read_json_or_none(path)
        was_hit = was_hit or (isinstance(entry, dict) and entry.get('hit') is True)
        path.unlink(missing_ok=True)
    return was_hit


def cmd_resume(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    tmux = Tmux(ctx.run)
    pane = tmux.pane(ns.target)
    path = flag_path_for(ctx.paths, tmux, ns.target) if pane is not None else None
    with _locked(ctx.paths):
        if path is not None:
            flags = [path] if path.exists() else []
        else:  # the pane is gone: its flags can only be stale
            flags = [flag for flag in _flag_files(ctx.paths) if _flag_target(flag) == ns.target]
        was_hit = _remove_flags(flags)
    if not was_hit or pane is None or not is_claude_pane(pane, ctx.proc_root) or pending_qid_for(ctx, ns.target):
        return {'ok': True, 'was_hit': was_hit, 'sent': False}
    send_text(tmux, ctx.paths.state / 'send.lock', ns.target, RESUME_TEXT, ctx.sleep)
    return {'ok': True, 'was_hit': True, 'sent': True}


def _payload(raw: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(raw.decode('utf-8'))
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def record_hit(flag: str, raw: bytes, env: hook.HookEnv, resume_delay: float = RESUME_AFTER_HIT_SECONDS) -> None:
    name = Path(flag).name
    if not FLAG_NAME_RE.fullmatch(name) or Path(flag).parent.name != 'pause':
        raise ValueError(f'not a pause flag: {flag!r}')
    path = env.paths.pause / name
    payload = _payload(raw)
    if payload.get('hook_event_name') == NOT_A_STOP_EVENT:
        return  # an entry left by an earlier kit 2: Claude Code ignores this stop, so nothing was paused
    with _locked(env.paths):
        entry = common.read_json_or_none(path)
        lifted = not isinstance(entry, dict)
        if not lifted and entry.get('hit') is not True:
            common.atomic_write_json(path, {**entry, 'hit': True})
    target = hook.event_target(env, payload.get('session_id'))
    # Written even when resume removed the flag a moment ago: the shell already printed the stop line.
    hook.append(env, common.load_config(env.paths), 'paused', hook.event_meta(payload, target), {})
    if lifted:
        resume_later(env, resume_delay)


def resume_later(env: hook.HookEnv, delay: float) -> None:
    """`resume` ran between the shell's stop line and this hit, saw no hit and typed nothing, yet the session is
    stopping now. A detached process types RESUME_TEXT once the stop has taken effect (this hook must exit first,
    and its output pipe must not be held open)."""
    pane_id, server_pid = hook.tmux_ids(env.environ)
    if pane_id is None or server_pid is None:
        return
    root = str(Path(__file__).resolve().parent.parent)
    code = 'import sys; sys.path.insert(0, sys.argv[1]); from luady_kit.pause import resume_main; resume_main(*sys.argv[2:])'
    subprocess.Popen([sys.executable, '-I', '-c', code, root, pane_id, server_pid, str(delay)],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True, env={**os.environ, 'HOME': str(env.paths.home)})


def resume_main(pane_id: str, server_pid: str, delay: str) -> int:
    """The detached half of resume_later: wait, then type RESUME_TEXT unless the pane was paused again, has a pending
    question, no longer runs Claude or belongs to another tmux server."""
    from .ctl import Ctx

    ctx = Ctx(paths=common.KitPaths.from_env())
    try:
        time.sleep(float(delay))
        tmux = Tmux(ctx.run)
        shown_pid, _, target = (tmux.display(pane_id, '#{pid}\t' + TARGET_FORMAT) or '').partition('\t')
        if shown_pid != server_pid or (ctx.paths.pause / flag_name(server_pid, pane_id)).exists():
            return 0
        pane = tmux.pane(target) if common.matches(common.TARGET_RE, target) else None
        if pane is None or not is_claude_pane(pane, ctx.proc_root) or pending_qid_for(ctx, target):
            return 0
        send_text(tmux, ctx.paths.state / 'send.lock', target, RESUME_TEXT, ctx.sleep)
    except Exception as exc:  # noqa: BLE001 - detached: the log is the only place left
        common.log_hook_error(ctx.paths, f'resume after a lifted pause failed: {type(exc).__name__}: {exc}')
    return 0


def hit_main(flag: str, *, stdin: BinaryIO | None = None, env: hook.HookEnv | None = None,
             resume_delay: float | None = None) -> int:
    """The slow path of the pause check (a flag exists for this pane): always 0, never prints."""
    hook_env = env if env is not None else hook.default_env()
    try:
        source = stdin if stdin is not None else sys.stdin.buffer
        raw = b'' if stdin is None and sys.stdin.isatty() else source.read(hook.STDIN_MAX_BYTES)
        record_hit(flag, raw, hook_env, RESUME_AFTER_HIT_SECONDS if resume_delay is None else resume_delay)
    except BaseException as exc:  # noqa: BLE001 - a hook must never break the Claude session
        common.log_hook_error(hook_env.paths, f'pause hit failed: {type(exc).__name__}: {exc}')
    return 0


def _server_is_live(path: Path, proc_root: str) -> bool:
    """The flag's tmux server still runs: its pid is a tmux process started when the flag was written (after a reboot
    the pid can belong to another process, or to a new tmux server)."""
    server_pid = int(path.name.split('-', 1)[0])
    try:
        comm = Path(proc_root, str(server_pid), 'comm').read_text(encoding='utf-8', errors='replace')
    except OSError:
        return False
    if not comm.startswith('tmux'):
        return False
    entry = common.read_json_or_none(path)
    recorded = entry.get('server_start') if isinstance(entry, dict) else None
    return not isinstance(recorded, int) or common.proc_start_ticks(server_pid, proc_root) == recorded


def purge_stale_flags(paths: common.KitPaths, now_ts: float, proc_root: str) -> None:
    """Delete flags older than 7 days and flags whose tmux server is gone or was replaced."""
    for path in _flag_files(paths):
        try:
            old = path.stat().st_mtime < now_ts - FLAG_MAX_AGE_SECONDS
        except FileNotFoundError:
            continue
        if old or not _server_is_live(path, proc_root):
            path.unlink(missing_ok=True)
