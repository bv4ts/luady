"""Shell exec and file access verbs of luady-ctl: output caps, timeouts and the deny list."""
from __future__ import annotations

import base64
import binascii
import re
import codecs
import os
import stat
import subprocess
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO, Iterable, Mapping

from . import common
from .common import CtlError

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

EXEC_STDIN_MAX = 65536
FILE_WRITE_MAX = 1024 * 1024
READER_JOIN_SECONDS = 2.0
FILE_PUT_MAX = 64 * 1024 * 1024
FILE_PUT_B64_MAX = (FILE_PUT_MAX + 2) // 3 * 4 + 1024
INBOX_DIR = 'luady-inbox'
INBOX_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
# The deny list of file-read, file-get and file-write. It is short, not a boundary: these verbs reach every other file
# this user can. Paths are compared as given and by their real path, so a symlink or `..` does not get around it.
DENIED_EXACT = ('/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-')
DENIED_PREFIXES = ('/etc/sudoers',)
# Folders under the home folder: SSH keys, the kit's waiting questions (full tool inputs) and answers.
HOME_TREES = (('.ssh',), ('.luady', 'answers'), ('.luady', 'pending'))
# Credential files of common tools.
HOME_FILES = (('.claude', '.credentials.json'), ('.claude.json',), ('.aws', 'credentials'), ('.git-credentials',),
              ('.netrc',), ('.npmrc',), ('.docker', 'config.json'), ('.kube', 'config'))
# Writing is refused here too: the kit's settings name the Claude Code binary the next `start` runs.
HOME_WRITE_ONLY = (('.luady', 'state', 'config.json'),)
# The hub's own folder (config, secrets, database) under each XDG base folder, as packages/hub/src/config/defaults.ts
# names them, and the GitHub CLI's sign-in file under the config folder.
HUB_DIR = 'luady'
XDG_BASES = (('XDG_CONFIG_HOME', ('.config',)), ('XDG_DATA_HOME', ('.local', 'share')),
             ('XDG_STATE_HOME', ('.local', 'state')))
_PROC_ENVIRON = re.compile(r'/proc/[^/]+(?:/task/[^/]+)?/environ')


def _xdg_bases(home: str, environ: Mapping[str, str]) -> list[tuple[str, str]]:
    """(variable, folder) for each XDG base: its default under home, and the variable's value when it is absolute."""
    bases = []
    for name, default in XDG_BASES:
        bases.append((name, os.path.join(home, *default)))
        value = (environ.get(name) or '').strip()
        if os.path.isabs(value):
            bases.append((name, value))
    return bases


def _with_real_paths(paths: Iterable[str]) -> set[str]:
    return {variant for path in paths for variant in (path, os.path.realpath(path))}


def _denied_rules(home: str, environ: Mapping[str, str], write: bool) -> tuple[set[str], set[str]]:
    """(trees, files) refused for one home folder, each also by its real path."""
    trees = [os.path.join(home, *parts) for parts in HOME_TREES]
    files = [os.path.join(home, *parts) for parts in HOME_FILES + (HOME_WRITE_ONLY if write else ())]
    for name, base in _xdg_bases(home, environ):
        trees.append(os.path.join(base, HUB_DIR))
        if name == 'XDG_CONFIG_HOME':
            files.append(os.path.join(base, 'gh', 'hosts.yml'))
    return _with_real_paths(trees), _with_real_paths(files)


def denied_reason(path: str, home: str, write: bool = False, environ: Mapping[str, str] | None = None) -> str | None:
    """Why `path` may not be read (or, with `write`, written), also through symlinks; None when it is allowed."""
    env = os.environ if environ is None else environ
    trees, files = set(), set()
    for base in {home.rstrip('/') or '/', os.path.realpath(home)}:
        more_trees, more_files = _denied_rules(base, env, write)
        trees, files = trees | more_trees, files | more_files
    for candidate in (path, os.path.realpath(path)):
        if (candidate in DENIED_EXACT or candidate.startswith(DENIED_PREFIXES) or candidate in files
                or _PROC_ENVIRON.fullmatch(candidate) or any(candidate == tree or candidate.startswith(tree + '/')
                                                             for tree in trees)):
            return f'{path} is on the deny list'
    return None


def check_allowed(path: str, home: str, write: bool = False) -> None:
    reason = denied_reason(path, home, write)
    if reason is not None:
        raise CtlError('refused', reason)


def decode_capped(data: bytes, truncated: bool) -> str:
    """UTF-8 text. When the bytes were cut, an incomplete trailing multi-byte sequence is dropped."""
    return codecs.getincrementaldecoder('utf-8')('replace').decode(data, final=not truncated)


class _Capture:
    """Drains one pipe in a daemon thread and keeps at most `cap` bytes."""

    def __init__(self, stream: BinaryIO, cap: int) -> None:
        self._fd = stream.fileno()
        self._cap = cap
        self._data = bytearray()
        self._truncated = False
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        while chunk := os.read(self._fd, 65536):
            with self._lock:
                room = self._cap - len(self._data)
                self._data.extend(chunk[:max(room, 0)])
                self._truncated = self._truncated or len(chunk) > room

    def result(self) -> tuple[bytes, bool]:
        self._thread.join(READER_JOIN_SECONDS)
        with self._lock:
            return bytes(self._data), self._truncated


def run_capped(argv: list[str], cwd: str, timeout: int, cap: int) -> dict[str, Any]:
    """Run argv in its own process group. Each stream is capped at `cap` bytes; on timeout the group is killed."""
    proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)
    out, err = _Capture(proc.stdout, cap), _Capture(proc.stderr, cap)
    try:
        proc.wait(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        common.kill_group(proc.pid)
        proc.wait()
        timed_out = True
    (out_data, out_cut), (err_data, err_cut) = out.result(), err.result()
    proc.stdout.close()
    proc.stderr.close()
    return {'exit': proc.returncode, 'stdout': decode_capped(out_data, out_cut),
            'stderr': decode_capped(err_data, err_cut), 'truncated': out_cut or err_cut, 'timed_out': timed_out}


def cmd_exec(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    command = kit_io.read_text(EXEC_STDIN_MAX)
    if not command.strip():
        raise CtlError('usage', 'command on stdin is empty')
    if '\x00' in command:
        raise CtlError('usage', 'command contains a NUL character')
    if not os.path.isdir(ns.cwd):
        raise CtlError('not_found', f'cwd does not exist: {ns.cwd}')
    return run_capped(['bash', '-lc', command], ns.cwd, ns.timeout, common.EXEC_OUTPUT_MAX)


def cmd_file_read(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    check_allowed(ns.path, str(ctx.paths.home))
    try:
        fd = os.open(ns.path, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError as exc:
        raise CtlError('not_found', f'no such file: {ns.path}') from exc
    except PermissionError as exc:
        raise CtlError('refused', f'permission denied: {ns.path}') from exc
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise CtlError('usage', f'{ns.path} is not a regular file')
    with os.fdopen(fd, 'rb') as handle:
        data = handle.read(ns.max + 1)
    truncated = len(data) > ns.max or info.st_size > ns.max
    return {'path': ns.path, 'size': info.st_size, 'content': decode_capped(data[:ns.max], truncated),
            'truncated': truncated}


def cmd_file_get(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    """Whole file as base64 (binary-safe, for images); refuses files larger than --max."""
    check_allowed(ns.path, str(ctx.paths.home))
    try:
        fd = os.open(ns.path, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError as exc:
        raise CtlError('not_found', f'no such file: {ns.path}') from exc
    except PermissionError as exc:
        raise CtlError('refused', f'permission denied: {ns.path}') from exc
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise CtlError('usage', f'{ns.path} is not a regular file')
    if info.st_size > ns.max:
        os.close(fd)
        raise CtlError('usage', f'{ns.path} is {info.st_size} bytes, over the {ns.max} byte limit')
    with os.fdopen(fd, 'rb') as handle:
        data = handle.read(ns.max + 1)
    if len(data) > ns.max:
        raise CtlError('usage', f'{ns.path} grew past the {ns.max} byte limit')
    return {'path': ns.path, 'size': len(data), 'b64': base64.b64encode(data).decode('ascii')}


def _unique_inbox_path(inbox: Path, name: str) -> Path:
    target = inbox / name
    stem, dot, ext = name.partition('.')
    counter = 1
    while target.exists():
        target = inbox / f'{stem}-{counter}{dot}{ext}'
        counter += 1
    return target


def cmd_file_put(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    """Base64 on stdin -> ~/luady-inbox/<name> (never overwrites: name-1.ext, name-2.ext, ...)."""
    if not INBOX_NAME_RE.fullmatch(ns.name) or '..' in ns.name:  # fullmatch: '$' alone lets a final newline through
        raise CtlError('usage', f'invalid file name: {ns.name!r}')
    raw = kit_io.read_bytes(FILE_PUT_B64_MAX)
    try:
        data = base64.b64decode(raw.strip(), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CtlError('usage', 'stdin is not valid base64') from exc
    if not data:
        raise CtlError('usage', 'the file is empty')
    if len(data) > FILE_PUT_MAX:
        raise CtlError('usage', f'the file is {len(data)} bytes, over the {FILE_PUT_MAX} byte limit')
    inbox = Path(ctx.paths.home) / INBOX_DIR
    inbox.mkdir(mode=0o700, exist_ok=True)
    common.close_to_others(inbox)  # only this user reads what arrives
    target = _unique_inbox_path(inbox, ns.name)
    common.atomic_write_bytes(target, data, 0o600)
    return {'path': str(target), 'size': len(data)}


def cmd_file_write(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    data = kit_io.read_bytes(FILE_WRITE_MAX)
    check_allowed(ns.path, str(ctx.paths.home), write=True)
    target = Path(os.path.realpath(ns.path))
    if not target.parent.is_dir():
        raise CtlError('not_found', f'directory does not exist: {target.parent}')
    if target.exists() and not target.is_file():
        raise CtlError('usage', f'{target} is not a regular file')
    mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else None  # a new file follows the umask
    try:
        common.atomic_write_bytes(target, data, mode)
    except PermissionError as exc:
        raise CtlError('refused', f'permission denied: {target}') from exc
    return {'ok': True, 'bytes': len(data)}
