"""luady-ctl: the verb CLI the hub runs over SSH.

- Output: every verb prints exactly one JSON object; tail-events prints JSON lines.
- Failures print {"error": {"code", "message"}} and exit with the CTL_EXIT code.
- Free text arrives only on stdin.
- Verb handlers live in the module named in VERBS and are imported only when that verb runs.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, BinaryIO, Callable, Mapping, Sequence

from . import common
from .common import CtlError

VERBS: dict[str, tuple[str, str]] = {
    'version': ('sysinfo', 'cmd_version'),
    'sysinfo': ('sysinfo', 'cmd_sysinfo'),
    'sessions': ('transcripts', 'cmd_sessions'),
    'pending': ('hook', 'cmd_pending'),
    'tail-events': ('transcripts', 'cmd_tail_events'),
    'answer': ('hook', 'cmd_answer'),
    'permission': ('hook', 'cmd_permission'),
    'send': ('tmuxio', 'cmd_send'),
    'keys': ('tmuxio', 'cmd_keys'),
    'start': ('tmuxio', 'cmd_start'),
    'stop': ('tmuxio', 'cmd_stop'),
    'restart': ('tmuxio', 'cmd_restart'),
    'delete': ('transcripts', 'cmd_delete'),
    'transcript': ('transcripts', 'cmd_transcript'),
    'capture': ('tmuxio', 'cmd_capture'),
    'update-claude': ('sysinfo', 'cmd_update_claude'),
    'projects': ('projects', 'cmd_projects'),
    'exec': ('ops', 'cmd_exec'),
    'file-read': ('ops', 'cmd_file_read'),
    'file-get': ('ops', 'cmd_file_get'),
    'file-put': ('ops', 'cmd_file_put'),
    'graphify-run': ('graph', 'cmd_graphify_run'),
    'graph-query': ('graph', 'cmd_graph_query'),
    'file-write': ('ops', 'cmd_file_write'),
    'auth-status': ('auth', 'cmd_auth_status'),
    'auth-login': ('auth', 'cmd_auth_login'),
    'auth-code': ('auth', 'cmd_auth_code'),
    'config': ('ctl', 'cmd_config'),
    'pause': ('pause', 'cmd_pause'),
    'resume': ('pause', 'cmd_resume'),
    'auth-logout': ('auth', 'cmd_auth_logout'),
    'skills': ('skills', 'cmd_skills'),
    'kb-put': ('kb', 'cmd_kb_put'),
    'git-status': ('gitstatus', 'cmd_git_status'),
}
KEYS = ('Escape', 'C-c', 'Enter')
CONFIG_KEYS = ('remote_answering', 'hook_wait_seconds', 'host_alias')  # the `config` reply
FILE_READ_MAX = 1024 * 1024
FILE_GET_MAX = 64 * 1024 * 1024
OFFSET_MAX = 2 ** 53


@dataclass(frozen=True)
class Ctx:
    """Everything a verb needs from the outside world; tests replace any part."""

    paths: common.KitPaths
    projects_root: str = ''  # '' = ~/projects of paths.home (common.default_projects_root), filled in __post_init__
    run: Callable[..., common.RunResult] = common.run_process
    sleep: Callable[[float], None] = time.sleep
    monotonic: Callable[[], float] = time.monotonic
    now: Callable[[], datetime] = common.utc_now

    def __post_init__(self) -> None:
        if self.projects_root == '':
            object.__setattr__(self, 'projects_root', common.default_projects_root(self.paths.home))
    proc_root: str = '/proc'


class KitIO:
    """stdin/stdout of one luady-ctl run. Only verbs that take free text read stdin."""

    def __init__(self, stdin: BinaryIO, stdout: BinaryIO) -> None:
        self._stdin = stdin
        self._stdout = stdout

    def read_bytes(self, limit: int) -> bytes:
        data = self._stdin.read(limit + 1) or b''
        if len(data) > limit:
            raise CtlError('usage', f'stdin exceeds {limit} bytes')
        return data

    def read_text(self, limit: int) -> str:
        try:
            return self.read_bytes(limit).decode('utf-8')
        except UnicodeDecodeError as exc:
            raise CtlError('usage', f'stdin is not valid UTF-8 ({exc.reason})') from exc

    def read_json(self, limit: int) -> Any:
        text = self.read_text(limit)
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise CtlError('usage', f'stdin is not valid JSON ({exc.msg})') from exc

    def emit(self, obj: Any) -> None:
        self._stdout.write(common.dumps_line(obj))
        self._stdout.flush()


Handler = Callable[[argparse.Namespace, Ctx, KitIO], 'dict[str, Any] | None']


class _Parser(argparse.ArgumentParser):
    """argparse that raises CtlError('usage') instead of printing help and exiting."""

    def error(self, message: str):  # type: ignore[override]
        raise CtlError('usage', message)


def _pattern(pattern, label: str) -> Callable[[str], str]:
    def check(value: str) -> str:
        if not common.matches(pattern, value):
            raise argparse.ArgumentTypeError(f'invalid {label}: {value!r}')
        return value
    return check


def _abs_path(value: str) -> str:
    try:
        return common.normalize_abs_path(value)
    except CtlError as exc:
        raise argparse.ArgumentTypeError(exc.message) from exc


def _int_range(low: int, high: int) -> Callable[[str], int]:
    def check(value: str) -> int:
        if not (value.isascii() and value.isdigit()) or not low <= int(value) <= high:
            raise argparse.ArgumentTypeError(f'expected an integer from {low} to {high}, got {value!r}')
        return int(value)
    return check


def _tail_from(value: str) -> str:
    if value in ('start', 'end') or common.matches(common.TAIL_FROM_RE, value):
        return value
    raise argparse.ArgumentTypeError('expected start, end or events-YYYYMMDD.jsonl:<offset>')


_QID = {'required': True, 'type': _pattern(common.QID_RE, 'qid')}
_TARGET = {'required': True, 'type': _pattern(common.TARGET_RE, 'target')}
_SESSION = {'required': True, 'type': _pattern(common.SID_RE, 'session id')}
_PATH = {'required': True, 'type': _abs_path}

SPECS: dict[str, list[tuple[str, dict[str, Any]]]] = {
    'version': [], 'sysinfo': [], 'sessions': [], 'pending': [], 'update-claude': [], 'projects': [],
    'tail-events': [('--from', {'dest': 'from_spec', 'required': True, 'type': _tail_from})],
    'answer': [('--qid', _QID)],
    'permission': [('--qid', _QID)],
    'send': [('--target', _TARGET)],
    'keys': [('--target', _TARGET), ('--key', {'required': True, 'choices': KEYS})],
    'start': [('--name', {'required': True, 'type': _pattern(common.NAME_RE, 'name')}), ('--cwd', _PATH),
              ('--model', {'type': _pattern(common.MODEL_RE, 'model')}),
              ('--resume', {'type': _pattern(common.SID_RE, 'session id')})],
    'stop': [('--target', _TARGET), ('--force', {'action': 'store_true'})],
    'restart': [('--target', _TARGET)],
    'delete': [('--session', _SESSION)],
    'transcript': [('--session', _SESSION), ('--tail', {'type': _int_range(1, common.TRANSCRIPT_CHUNK_MAX)}),
                   ('--from', {'dest': 'from_offset', 'type': _int_range(0, OFFSET_MAX)}),
                   ('--before', {'type': _int_range(0, OFFSET_MAX)}),
                   ('--max', {'type': _int_range(1, common.TRANSCRIPT_CHUNK_MAX)})],
    'capture': [('--target', _TARGET),
                ('--lines', {'required': True, 'type': _int_range(1, common.CAPTURE_LINES_MAX)})],
    'exec': [('--cwd', _PATH), ('--timeout', {'required': True, 'type': _int_range(1, 600)})],
    'file-read': [('--path', _PATH), ('--max', {'required': True, 'type': _int_range(1, FILE_READ_MAX)})],
    'file-get': [('--path', _PATH), ('--max', {'required': True, 'type': _int_range(1, FILE_GET_MAX)})],
    'file-put': [('--name', {'required': True})],
    'graphify-run': [('--path', _PATH), ('--timeout', {'required': True, 'type': _int_range(60, 3600)})],
    'graph-query': [('--path', _PATH), ('--budget', {'required': True, 'type': _int_range(200, 8000)})],
    'file-write': [('--path', _PATH)],
    'auth-status': [], 'auth-login': [], 'auth-code': [], 'auth-logout': [],
    'pause': [('--target', _TARGET)],
    'resume': [('--target', _TARGET)],
    'skills': [], 'kb-put': [], 'git-status': [],
}


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog='luady-ctl', add_help=False, allow_abbrev=False)
    sub = parser.add_subparsers(dest='verb', required=True, parser_class=_Parser)
    for verb, specs in SPECS.items():
        verb_parser = sub.add_parser(verb, add_help=False, allow_abbrev=False)
        for flag, options in specs:
            verb_parser.add_argument(flag, **options)
    config = sub.add_parser('config', add_help=False, allow_abbrev=False)
    group = config.add_mutually_exclusive_group(required=True)
    group.add_argument('--get', action='store_true')
    group.add_argument('--set', metavar='KEY=VALUE')
    return parser


def _check_transcript(ns: argparse.Namespace) -> None:
    modes = [name for name in ('tail', 'from_offset', 'before') if getattr(ns, name) is not None]
    if len(modes) != 1:
        raise CtlError('usage', 'transcript needs exactly one of --tail, --from, --before')
    if modes == ['tail'] and ns.max is not None:
        raise CtlError('usage', '--max is not used with --tail')
    if modes != ['tail'] and ns.max is None:
        raise CtlError('usage', '--max is required with --from and --before')


def _resolve(verb: str, handlers: Mapping[str, Handler] | None) -> Handler:
    if handlers is not None and verb in handlers:
        return handlers[verb]
    module_name, function = VERBS[verb]
    if module_name == 'ctl':
        return globals()[function]
    try:
        module = importlib.import_module(f'{__package__}.{module_name}')
    except ImportError as exc:
        raise CtlError('failed', f'verb {verb} is not available: {exc}') from exc
    return getattr(module, function)


def build_ctx(environ: Mapping[str, str] | None = None) -> Ctx:
    """$HOME's paths with the projects root and Claude Code binary stored by the installer (the defaults when none)."""
    plain = common.KitPaths.from_env(environ)
    config = common.load_config(plain)
    return Ctx(paths=common.configured_paths(plain.home, config), projects_root=config['projects_root'])


def _fail(kit_io: KitIO, code: str, message: str) -> int:
    # stdout may already be closed by the caller; the exit code still carries the failure.
    with contextlib.suppress(OSError):
        kit_io.emit({'error': {'code': code, 'message': message}})
    return common.EXIT_CODES[code]


def main(argv: Sequence[str] | None = None, *, stdin: BinaryIO | None = None, stdout: BinaryIO | None = None,
         ctx: Ctx | None = None, handlers: Mapping[str, Handler] | None = None) -> int:
    kit_io = KitIO(stdin if stdin is not None else sys.stdin.buffer,
                   stdout if stdout is not None else sys.stdout.buffer)
    try:
        ns = build_parser().parse_args(list(sys.argv[1:] if argv is None else argv))
        if ns.verb == 'transcript':
            _check_transcript(ns)
        handler = _resolve(ns.verb, handlers)
        result = handler(ns, ctx if ctx is not None else build_ctx(), kit_io)
        if result is not None:
            kit_io.emit(result)
        return 0
    except CtlError as exc:
        return _fail(kit_io, exc.code, exc.message)
    except BrokenPipeError:
        return 0
    except Exception as exc:  # noqa: BLE001 - every failure must become exactly one JSON error object
        return _fail(kit_io, 'failed', f'{type(exc).__name__}: {exc}')


def cmd_config(ns: argparse.Namespace, ctx: Ctx, kit_io: KitIO) -> dict[str, Any]:
    """The config reply (CONFIG_KEYS). --set rewrites config.json and keeps the paths the installer stored."""
    stored = common.stored_path_settings(common.read_json_or_none(ctx.paths.config_file))
    loaded = common.load_config(ctx.paths)
    current = {key: loaded[key] for key in CONFIG_KEYS}
    if ns.set is None:
        return current
    key, sep, raw = ns.set.partition('=')
    if not sep:
        raise CtlError('usage', 'expected --set key=value')
    updated = {**current, key: _config_value(key, raw)}
    common.ensure_runtime_dirs(ctx.paths)
    common.atomic_write_json(ctx.paths.config_file, common.config_for_file(updated, stored))
    return updated


def _config_value(key: str, raw: str) -> bool | int:
    if key == 'remote_answering':
        if raw in ('true', 'false'):
            return raw == 'true'
        raise CtlError('usage', 'remote_answering must be true or false')
    if key == 'hook_wait_seconds':
        if raw.isascii() and raw.isdigit() and 60 <= int(raw) <= common.HOOK_WAIT_MAX_SECONDS:
            return int(raw)
        raise CtlError('usage', 'hook_wait_seconds must be an integer from 60 to 86400')
    raise CtlError('usage', f'unknown config key {key!r}; allowed: remote_answering, hook_wait_seconds')


if __name__ == '__main__':
    sys.exit(main())
