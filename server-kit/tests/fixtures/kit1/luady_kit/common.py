"""Shared building blocks of the Luady server kit.

Contents:
- limits and patterns, and the ~/.luady layout
- time and ids, text truncation and the prompt hash
- a shell-free process runner
- atomic and flock'ed file writes
- the event spool and the config file
- the pending/answer store and the session registry

Standard library only.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

LAST_ASSISTANT_MESSAGE_MAX = 8000
PROMPT_PREVIEW_MAX = 200
NOTIFICATION_MESSAGE_MAX = 1000
STOP_FAILURE_ERROR_MAX = 2000
PERMISSION_INPUT_PREVIEW_MAX = 2000
TRANSCRIPT_CHUNK_MAX = 524288
EXEC_OUTPUT_MAX = 65536
CAPTURE_LINES_MAX = 500
SEND_TEXT_MAX = 20000
HOOK_WAIT_MAX_SECONDS = 86400
DEFAULT_HOOK_WAIT_SECONDS = 14400
DEFAULT_PROJECTS_ROOT = '/home/dev/projects'

QID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
QID_RE = re.compile(r'[A-Z2-7]{8}', re.ASCII)
NAME_RE = re.compile(r'[A-Za-z0-9._-]{1,64}', re.ASCII)
TARGET_RE = re.compile(r'[A-Za-z0-9._-]{1,64}:[0-9]{1,3}\.[0-9]{1,3}', re.ASCII)
SID_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', re.ASCII)
MODEL_RE = re.compile(r'[A-Za-z0-9._:\[\]-]{1,64}', re.ASCII)
HOST_ALIAS_RE = re.compile(r'[A-Za-z0-9._-]{1,32}', re.ASCII)
SPOOL_FILE_RE = re.compile(r'events-([0-9]{8})\.jsonl', re.ASCII)
TAIL_FROM_RE = re.compile(r'(events-[0-9]{8}\.jsonl):([0-9]{1,15})', re.ASCII)

EXIT_CODES = {'ok': 0, 'failed': 1, 'usage': 2, 'refused': 3, 'not_found': 4, 'timeout': 5}
RUNTIME_DIRS = ('spool', 'pending', 'answers', 'registry', 'state', 'trash', 'backup')
ELLIPSIS = '\u2026'
_LONE_SURROGATE = re.compile('[\ud800-\udfff]')


def matches(pattern: re.Pattern[str], value: Any) -> bool:
    """True when value is a str that fully matches pattern (never a trailing-newline match)."""
    return isinstance(value, str) and pattern.fullmatch(value) is not None


class CtlError(Exception):
    """A luady-ctl failure carrying a CtlErrorCode."""

    def __init__(self, code: str, message: str) -> None:
        if code not in EXIT_CODES or code == 'ok':
            raise ValueError(f'unknown ctl error code: {code}')
        super().__init__(message)
        self.code = code
        self.message = message


def _home_path(*parts: str) -> property:
    """A read-only KitPaths property for home/<parts…>."""
    return property(lambda self: self.home.joinpath(*parts))


@dataclass(frozen=True)
class KitPaths:
    """Every path the kit uses, derived from one home directory."""

    home: Path

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> 'KitPaths':
        env = os.environ if environ is None else environ
        return cls(Path(env.get('HOME') or os.path.expanduser('~')))

    root = _home_path('.luady')
    lib = _home_path('.luady', 'lib')
    bin = _home_path('.luady', 'bin')
    hooks = _home_path('.luady', 'hooks')
    spool = _home_path('.luady', 'spool')
    pending = _home_path('.luady', 'pending')
    answers = _home_path('.luady', 'answers')
    registry = _home_path('.luady', 'registry')
    state = _home_path('.luady', 'state')
    trash = _home_path('.luady', 'trash')
    backup = _home_path('.luady', 'backup')
    config_file = _home_path('.luady', 'state', 'config.json')
    hook_errors = _home_path('.luady', 'state', 'hook-errors.log')
    claude_projects = _home_path('.claude', 'projects')
    claude_settings = _home_path('.claude', 'settings.json')
    claude_bin = _home_path('.local', 'bin', 'claude')


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(moment: datetime) -> str:
    """ISO-8601 UTC with milliseconds and Z, e.g. 2026-10-09T19:42:11.123Z."""
    return moment.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def utc_day(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime('%Y%m%d')


def compact_stamp(moment: datetime) -> str:
    """Sortable, file-name-safe UTC stamp, e.g. 20261009T194211123Z."""
    utc = moment.astimezone(timezone.utc)
    return utc.strftime('%Y%m%dT%H%M%S') + f'{utc.microsecond // 1000:03d}Z'


def new_qid() -> str:
    return ''.join(secrets.choice(QID_ALPHABET) for _ in range(8))


def new_event_id() -> str:
    return str(uuid.uuid4())


def as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def truncate_chars(text: str, limit: int) -> tuple[str, bool]:
    """Cut text to at most `limit` characters, ending with … when cut. Returns (text, was_cut)."""
    if limit < 1:
        raise ValueError('limit must be at least 1')
    if len(text) <= limit:
        return text, False
    return text[: limit - 1] + ELLIPSIS, True


def normalize_for_hash(text: str) -> str:
    return text.replace('\r\n', '\n').strip(' \t\n\r\f\v')


def prompt_hash(text: str) -> str:
    """sha256 hex of the normalized prompt as UTF-8, identical to promptHash in @luady/shared."""
    clean = _LONE_SURROGATE.sub('\ufffd', normalize_for_hash(text))
    return hashlib.sha256(clean.encode('utf-8')).hexdigest()


def normalize_abs_path(value: str) -> str:
    """Absolute, NUL/newline-free path through os.path.normpath; a leading '//' collapses to '/'."""
    if not value or '\x00' in value or '\n' in value:
        raise CtlError('usage', 'path must be non-empty and contain no NUL or newline')
    if not value.startswith('/'):
        raise CtlError('usage', f'path must be absolute: {value}')
    return '/' + os.path.normpath(value).lstrip('/')


@dataclass(frozen=True)
class RunResult:
    code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False

    @property
    def text(self) -> str:
        return self.stdout.decode('utf-8', 'replace')


def kill_group(pid: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pid, signal.SIGKILL)


def run_process(argv: list[str], input_bytes: bytes | None = None, timeout: float = 10.0,
                cwd: str | None = None) -> RunResult:
    """Run argv without a shell in its own process group; a missing binary is 127, a timeout 124."""
    stdin = subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL
    try:
        proc = subprocess.Popen(argv, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
                                start_new_session=True)
    except OSError as exc:
        return RunResult(127, b'', str(exc).encode('utf-8', 'replace'))
    try:
        out, err = proc.communicate(input_bytes, timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_group(proc.pid)
        out, err = proc.communicate()
        return RunResult(124, out, err, timed_out=True)
    return RunResult(proc.returncode, out, err)


def dumps_line(obj: Any) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8', 'replace')


def dumps_pretty(obj: Any) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + '\n').encode('utf-8', 'replace')


def _tmp_sibling(path: Path) -> Path:
    return path.with_name(f'.{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp')


def _write_new_file(path: Path, data: bytes, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, mode)


def atomic_write_bytes(path: Path, data: bytes, mode: int = 0o600) -> None:
    """Write via a temp file in the same directory, then an atomic rename."""
    tmp = _tmp_sibling(path)
    try:
        _write_new_file(tmp, data, mode)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)


def atomic_write_json(path: Path, obj: Any, mode: int = 0o600) -> None:
    atomic_write_bytes(path, dumps_pretty(obj), mode)


def exclusive_write_json(path: Path, obj: Any, mode: int = 0o600) -> bool:
    """Atomically create path holding obj; returns False (and changes nothing) when path already exists."""
    tmp = _tmp_sibling(path)
    try:
        _write_new_file(tmp, dumps_pretty(obj), mode)
        os.link(tmp, path)
        return True
    except FileExistsError:
        return False
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)


def read_json_or_none(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def append_line_locked(path: Path, line: bytes) -> None:
    """Append one line under an exclusive flock so concurrent writers never interleave."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        view = memoryview(line)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def ensure_runtime_dirs(paths: KitPaths) -> None:
    paths.root.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in RUNTIME_DIRS:
        (paths.root / name).mkdir(mode=0o700, exist_ok=True)


def build_record(event: str, host: str, meta: Mapping[str, Any], data: dict[str, Any],
                 moment: datetime) -> dict[str, Any]:
    """One spool v1 record (SpoolEvent)."""
    return {
        'v': 1, 'id': new_event_id(), 'ts': iso_utc(moment), 'host': host, 'event': event,
        'session_id': as_str(meta.get('session_id')), 'cwd': as_str(meta.get('cwd')),
        'transcript_path': as_str(meta.get('transcript_path')), 'tmux': as_str(meta.get('tmux')),
        'permission_mode': as_str(meta.get('permission_mode')), 'data': data,
    }


def append_event(paths: KitPaths, record: dict[str, Any]) -> None:
    """Append a record to the spool file of its own UTC day (from record['ts'])."""
    paths.spool.mkdir(mode=0o700, parents=True, exist_ok=True)
    day = str(record['ts'])[:10].replace('-', '')
    append_line_locked(paths.spool / f'events-{day}.jsonl', dumps_line(record))


def default_config(host_alias: str) -> dict[str, Any]:
    return {'remote_answering': True, 'hook_wait_seconds': DEFAULT_HOOK_WAIT_SECONDS, 'host_alias': host_alias}


def fallback_host_alias() -> str:
    name = re.sub(r'[^A-Za-z0-9._-]', '-', socket.gethostname().split('.')[0])[:32]
    return name or 'unknown'


def load_config(paths: KitPaths) -> dict[str, Any]:
    """state/config.json with every invalid or missing value replaced by its default."""
    loaded = read_json_or_none(paths.config_file)
    raw = loaded if isinstance(loaded, dict) else {}
    remote, wait, alias = raw.get('remote_answering'), raw.get('hook_wait_seconds'), raw.get('host_alias')
    wait_ok = isinstance(wait, int) and not isinstance(wait, bool) and 1 <= wait <= HOOK_WAIT_MAX_SECONDS
    return {
        'remote_answering': remote if isinstance(remote, bool) else True,
        'hook_wait_seconds': wait if wait_ok else DEFAULT_HOOK_WAIT_SECONDS,
        'host_alias': alias if matches(HOST_ALIAS_RE, alias) else fallback_host_alias(),
    }


def log_hook_error(paths: KitPaths, message: str) -> None:
    """Best-effort append to state/hook-errors.log.

    It must never raise: this log is the last place a hook failure can go, and a hook may not break the
    Claude session.
    """
    try:
        paths.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        line = f'{iso_utc(utc_now())} {message}'.replace('\n', ' ')[:4000] + '\n'
        append_line_locked(paths.hook_errors, line.encode('utf-8', 'replace'))
    except Exception:  # noqa: BLE001 - nowhere left to report the failure (see docstring)
        return


def read_proc_stat(pid: int, proc_root: str = '/proc') -> list[str] | None:
    """Fields of /proc/<pid>/stat after the command name: [state, ppid, …]; None when unreadable."""
    try:
        raw = Path(proc_root, str(pid), 'stat').read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None
    end = raw.rfind(')')
    return raw[end + 2:].split() if end >= 0 else None


def proc_start_ticks(pid: int, proc_root: str = '/proc') -> int | None:
    fields = read_proc_stat(pid, proc_root)
    try:
        return int(fields[19]) if fields else None
    except (IndexError, ValueError):
        return None


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def waiter_alive(entry: Mapping[str, Any], proc_root: str = '/proc') -> bool:
    """True while the hook process that wrote a pending entry still runs (pid and start time match)."""
    pid = entry.get('pid')
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    fields = read_proc_stat(pid, proc_root)
    if not fields:
        return _pid_exists(pid)
    if fields[0] in ('Z', 'X'):
        return False
    start = entry.get('pid_start')
    return not isinstance(start, int) or proc_start_ticks(pid, proc_root) == start


def pending_path(paths: KitPaths, qid: str) -> Path:
    return paths.pending / f'{qid}.json'


def answer_path(paths: KitPaths, qid: str) -> Path:
    return paths.answers / f'{qid}.json'


def list_pending(paths: KitPaths) -> list[dict[str, Any]]:
    entries = []
    for path in sorted(paths.pending.glob('*.json')):
        entry = read_json_or_none(path)
        if (isinstance(entry, dict) and matches(QID_RE, entry.get('qid')) and entry['qid'] == path.stem
                and entry.get('kind') in ('question', 'permission')):
            entries.append(entry)
    return entries


def claim_pending(paths: KitPaths, qid: str) -> bool:
    """Remove pending/<qid>.json; True only for the caller that actually removed it."""
    try:
        pending_path(paths, qid).unlink()
    except FileNotFoundError:
        return False
    return True


def remove_answer(paths: KitPaths, qid: str) -> None:
    with contextlib.suppress(FileNotFoundError):
        answer_path(paths, qid).unlink()


def reap_dead_pending(paths: KitPaths, host: str, moment: datetime, proc_root: str = '/proc') -> list[str]:
    """Resolve pending items whose waiting hook process is gone (outcome error). Returns their qids."""
    reaped = []
    for entry in list_pending(paths):
        if waiter_alive(entry, proc_root) or not claim_pending(paths, entry['qid']):
            continue
        remove_answer(paths, entry['qid'])
        meta = entry['meta'] if isinstance(entry.get('meta'), dict) else {}
        data = {'qid': entry['qid'], 'outcome': 'error'}
        append_event(paths, build_record(f"{entry['kind']}_resolved", host, meta, data, moment))
        reaped.append(entry['qid'])
    return reaped


def live_pending(paths: KitPaths, host: str, moment: datetime, proc_root: str = '/proc') -> list[dict[str, Any]]:
    reap_dead_pending(paths, host, moment, proc_root)
    return list_pending(paths)


def registry_path(paths: KitPaths, sid: str) -> Path:
    return paths.registry / f'{sid}.json'


def write_registry(paths: KitPaths, entry: dict[str, Any]) -> None:
    paths.registry.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic_write_json(registry_path(paths, entry['session_id']), entry)


def read_registry(paths: KitPaths, sid: str) -> dict[str, Any] | None:
    entry = read_json_or_none(registry_path(paths, sid))
    return entry if isinstance(entry, dict) else None


def remove_registry(paths: KitPaths, sid: str) -> None:
    with contextlib.suppress(FileNotFoundError):
        registry_path(paths, sid).unlink()


def list_registry(paths: KitPaths) -> list[dict[str, Any]]:
    entries = (read_json_or_none(p) for p in sorted(paths.registry.glob('*.json')))
    return [e for e in entries if isinstance(e, dict) and matches(SID_RE, e.get('session_id'))]


def registry_for_target(entries: list[dict[str, Any]], target: str, pane_pid: int | None) -> dict[str, Any] | None:
    """Newest registry entry for a tmux target. When both sides know the pane pid they must agree."""
    candidates = [e for e in entries if e.get('tmux') == target and (
        pane_pid is None or not isinstance(e.get('pane_pid'), int) or e['pane_pid'] == pane_pid)]
    return max(candidates, key=lambda e: str(e.get('started_at') or '')) if candidates else None
