"""Claude sessions and their JSONL files.

- Byte windows over transcripts that return complete lines only.
- Transcript lookup.
- The event-spool tailer.
- The verbs transcript, tail-events, sessions and delete.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO, Callable

from . import common
from .common import CtlError
from .pause import paused_targets
from .tmuxio import Pane, Tmux, is_claude_pane, stop_pane

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

TAIL_POLL_SECONDS = 0.25
HEARTBEAT_SECONDS = common.TAIL_HEARTBEAT_SECONDS
ROTATION_GRACE_SECONDS = 2.0
TAIL_READ_MAX = 1 << 20
SCAN_CHUNK = 1 << 16
_NON_ALNUM = re.compile(r'[^A-Za-z0-9]', re.ASCII)


def encode_project_dir(cwd: str) -> str:
    """The ~/.claude/projects/<dir> name for a cwd: every non-alphanumeric character becomes '-'."""
    return _NON_ALNUM.sub('-', cwd)


def newest_jsonl(directory: Path) -> Path | None:
    files = [path for path in directory.glob('*.jsonl') if path.is_file()]
    return max(files, key=lambda path: path.stat().st_mtime) if files else None


def best_guess(paths: common.KitPaths, cwd: str) -> Path | None:
    return newest_jsonl(paths.claude_projects / encode_project_dir(cwd))


def find_transcript(paths: common.KitPaths, sid: str) -> Path | None:
    entry = common.read_registry(paths, sid)
    recorded = common.as_str(entry.get('transcript_path')) if entry else None
    if recorded and recorded.endswith('.jsonl') and Path(recorded).is_file():
        return Path(recorded)
    return next((path for path in sorted(paths.claude_projects.glob(f'*/{sid}.jsonl')) if path.is_file()), None)


def _last_newline_end(handle: BinaryIO, end: int) -> int:
    """Offset just after the last '\\n' before `end` (0 when there is none)."""
    pos = end
    while pos > 0:
        low = max(0, pos - SCAN_CHUNK)
        handle.seek(low)
        idx = handle.read(pos - low).rfind(b'\n')
        if idx >= 0:
            return low + idx + 1
        pos = low
    return 0


def _next_line_end(handle: BinaryIO, start: int, size: int) -> int | None:
    """Offset just after the first '\\n' at or after `start`; None while that line is incomplete."""
    pos = start
    while pos < size:
        handle.seek(pos)
        chunk = handle.read(min(SCAN_CHUNK, size - pos))
        idx = chunk.find(b'\n')
        if idx >= 0:
            return pos + idx + 1
        pos += len(chunk)
    return None


def _skipped(nbytes: int) -> bytes:
    return (json.dumps({'type': 'luady_skipped', 'bytes': nbytes}) + '\n').encode('ascii')


def window_from(handle: BinaryIO, size: int, start: int, max_bytes: int) -> tuple[bytes, int, int]:
    """Complete lines starting at `start`, at most max_bytes. A single longer line becomes a placeholder."""
    if start >= size:
        return b'', size, size
    handle.seek(start)
    chunk = handle.read(min(max_bytes, size - start))
    cut = chunk.rfind(b'\n')
    if cut >= 0:
        return chunk[:cut + 1], start, start + cut + 1
    end = _next_line_end(handle, start, size)
    return (b'', start, start) if end is None else (_skipped(end - start), start, end)


def window_before(handle: BinaryIO, end: int, max_bytes: int) -> tuple[bytes, int, int]:
    """Complete lines ending at the line boundary `end`, at most max_bytes. One longer line becomes a placeholder."""
    if end <= 0:
        return b'', 0, 0
    low = max(0, end - max_bytes)
    handle.seek(low)
    chunk = handle.read(end - low)
    if low == 0:
        return chunk, 0, end
    first = chunk.find(b'\n')
    if 0 <= first < len(chunk) - 1:
        return chunk[first + 1:], low + first + 1, end
    start = _last_newline_end(handle, end - 1)
    return _skipped(end - start), start, end


def window_tail(handle: BinaryIO, size: int, max_bytes: int) -> tuple[bytes, int, int]:
    return window_before(handle, _last_newline_end(handle, size), max_bytes)


def _require_boundary(handle: BinaryIO, size: int, offset: int) -> None:
    if offset > size:
        raise CtlError('usage', f'offset {offset} is beyond the end of the transcript ({size} bytes)')
    if offset > 0:
        handle.seek(offset - 1)
        if handle.read(1) != b'\n':
            raise CtlError('usage', f'offset {offset} is not at a line boundary')


def cmd_transcript(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    path = find_transcript(ctx.paths, ns.session)
    if path is None:
        raise CtlError('not_found', f'no transcript for session {ns.session}')
    with path.open('rb') as handle:
        size = os.fstat(handle.fileno()).st_size
        if ns.tail is not None:
            data, start, end = window_tail(handle, size, ns.tail)
        elif ns.from_offset is not None:
            _require_boundary(handle, size, ns.from_offset)
            data, start, end = window_from(handle, size, ns.from_offset, ns.max)
        else:
            _require_boundary(handle, size, ns.before)
            data, start, end = window_before(handle, ns.before, ns.max)
    return {'path': str(path), 'size': size, 'from': start, 'to': end, 'data': data.decode('utf-8', 'replace')}


@dataclass(frozen=True)
class TailState:
    file: str | None
    offset: int
    newer_seen_at: float | None = None


def spool_files(spool: Path) -> list[str]:
    try:
        names = os.listdir(spool)
    except OSError:
        return []
    return sorted(name for name in names if common.matches(common.SPOOL_FILE_RE, name))


def initial_state(spool: Path, spec: str) -> TailState:
    files = spool_files(spool)
    if spec == 'start':
        return TailState(files[0] if files else None, 0)
    if spec == 'end':
        return TailState(files[-1], (spool / files[-1]).stat().st_size) if files else TailState(None, 0)
    match = common.TAIL_FROM_RE.fullmatch(spec)
    if match is None:
        raise CtlError('usage', '--from must be start, end or events-YYYYMMDD.jsonl:<offset>')
    return TailState(match.group(1), int(match.group(2)))


def _parse_event(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def read_complete_lines(path: Path, offset: int, size: int) -> tuple[list[tuple[int, bytes]], int]:
    """Complete lines from offset as (offset after the line, raw line), plus the new offset.

    A single line longer than TAIL_READ_MAX is skipped.
    """
    with path.open('rb') as handle:
        handle.seek(offset)
        chunk = handle.read(min(size - offset, TAIL_READ_MAX))
        lines, pos = [], 0
        while (idx := chunk.find(b'\n', pos)) >= 0:
            lines.append((offset + idx + 1, chunk[pos:idx]))
            pos = idx + 1
        if not lines and len(chunk) == TAIL_READ_MAX:
            end = _next_line_end(handle, offset, size)
            return [], end if end is not None else offset
    return lines, offset + pos


def _maybe_rotate(spool: Path, state: TailState, now: float, grace: float) -> TailState:
    """At EOF, switch to the next newer file once it has existed for `grace` seconds with no new data here."""
    newer = [name for name in spool_files(spool) if name > (state.file or '')]
    if not newer:
        return TailState(state.file, state.offset)
    if state.newer_seen_at is None:
        return TailState(state.file, state.offset, now)
    if now - state.newer_seen_at < grace:
        return state
    return TailState(newer[0], 0)


def tail_step(spool: Path, state: TailState, now: float, grace: float) -> tuple[TailState, list[dict[str, Any]]]:
    """One poll: new complete lines of the current file, or a switch to the next file."""
    if state.file is None:
        files = spool_files(spool)
        return (TailState(files[0], 0), []) if files else (state, [])
    path = spool / state.file
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        newer = [name for name in spool_files(spool) if name > state.file]
        return (TailState(newer[0], 0), []) if newer else (state, [])
    offset = 0 if state.offset > size else state.offset
    if size > offset:
        lines, new_offset = read_complete_lines(path, offset, size)
        if new_offset > offset:
            parsed = [(end, _parse_event(raw)) for end, raw in lines]
            events = [{'file': state.file, 'offset': end, 'event': event}
                      for end, event in parsed if isinstance(event, dict)]
            return TailState(state.file, new_offset), events
    return _maybe_rotate(spool, TailState(state.file, offset, state.newer_seen_at), now, grace), []


def tail_events(spool: Path, spec: str, emit: Callable[[dict[str, Any]], None], *, now_iso: Callable[[], str],
                monotonic: Callable[[], float], sleep: Callable[[float], None], should_stop: Callable[[], bool],
                poll: float = TAIL_POLL_SECONDS, heartbeat: float = HEARTBEAT_SECONDS,
                grace: float = ROTATION_GRACE_SECONDS, alive: Callable[[], None] = lambda: None) -> None:
    """Stream spool lines and a heartbeat every `heartbeat` seconds. `alive` runs at the start and after each
    heartbeat was written: the hooks wait for a remote answer only while it ran recently."""
    state = initial_state(spool, spec)
    last_beat = monotonic()
    alive()
    while not should_stop():
        state, lines = tail_step(spool, state, monotonic(), grace)
        for line in lines:
            emit(line)
        if monotonic() - last_beat >= heartbeat:
            emit({'heartbeat': now_iso()})
            last_beat = monotonic()
            alive()
        if not lines:
            sleep(poll)


def cmd_tail_events(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> None:
    tail_events(ctx.paths.spool, ns.from_spec, kit_io.emit, now_iso=lambda: common.iso_utc(ctx.now()),
                monotonic=ctx.monotonic, sleep=ctx.sleep, should_stop=lambda: False,
                alive=lambda: common.touch_tail_alive(ctx.paths, ctx.now().timestamp()))


def _session_row(ctx: 'Ctx', pane: Pane, registry: list[dict[str, Any]],
                 pending: list[dict[str, Any]], paused: set[str]) -> dict[str, Any]:
    claude = is_claude_pane(pane, ctx.proc_root)
    entry = common.registry_for_target(registry, pane.target, pane.pane_pid) if claude else None
    guess = best_guess(ctx.paths, pane.cwd) if claude and entry is None else None
    mine = [item for item in pending if item.get('tmux') == pane.target]
    newest = max(mine, key=lambda item: str(item.get('created_at') or '')) if mine else None
    if entry is not None:
        sid, transcript = entry['session_id'], common.as_str(entry.get('transcript_path'))
    else:
        sid, transcript = (guess.stem, str(guess)) if guess else (None, None)
    return {'target': pane.target, 'tmux_session': pane.session, 'pane_pid': pane.pane_pid, 'command': pane.command,
            'cwd': pane.cwd, 'is_claude': claude, 'session_id': sid, 'transcript_path': transcript,
            'registered': entry is not None, 'pending_qid': newest['qid'] if newest else None,
            'paused': pane.target in paused}


def cmd_sessions(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    host = common.load_config(ctx.paths)['host_alias']
    registry = common.list_registry(ctx.paths)
    pending = common.live_pending(ctx.paths, host, ctx.now(), ctx.proc_root)
    tmux = Tmux(ctx.run)
    paused = paused_targets(ctx.paths, tmux)
    return {'sessions': [_session_row(ctx, pane, registry, pending, paused) for pane in tmux.list_panes()]}


def _stop_if_live(ctx: 'Ctx', sid: str) -> None:
    """Stop the pane only while its current registered session is still `sid`."""
    entry = common.read_registry(ctx.paths, sid)
    target = common.as_str(entry.get('tmux')) if entry else None
    if target is None:
        return
    tmux = Tmux(ctx.run)
    pane = tmux.pane(target)
    if pane is None or not is_claude_pane(pane, ctx.proc_root):
        return
    current = common.registry_for_target(common.list_registry(ctx.paths), target, pane.pane_pid)
    if current is not None and current.get('session_id') == sid:
        stop_pane(tmux, ctx, target, force=False)


def cmd_delete(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    transcript = find_transcript(ctx.paths, ns.session)
    if transcript is None:
        raise CtlError('not_found', f'no transcript for session {ns.session}')
    _stop_if_live(ctx, ns.session)
    ctx.paths.trash.mkdir(mode=0o700, parents=True, exist_ok=True)
    trashed = ctx.paths.trash / f'{common.compact_stamp(ctx.now())}-{ns.session}.jsonl'
    shutil.move(str(transcript), str(trashed))
    stamp = ctx.now().timestamp()
    os.utime(trashed, (stamp, stamp))
    common.remove_registry(ctx.paths, ns.session)
    return {'ok': True, 'trashed': str(trashed)}
