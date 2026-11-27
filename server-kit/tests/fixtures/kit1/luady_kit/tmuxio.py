"""tmux I/O for the Luady kit.

- An injectable tmux wrapper that always targets panes exactly ('=' prefix).
- Claude pane detection.
- The pane verbs send, keys, capture, start, stop and restart.

Free text only ever reaches tmux as argv elements (never a shell); `luady-ctl` itself only reads it from stdin.
"""
from __future__ import annotations

import contextlib
import fcntl
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterator

from . import common
from .common import CtlError, RunResult

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

PANE_FORMAT = ('#{session_name}:#{window_index}.#{pane_index}\t#{session_name}\t#{pane_pid}\t'
               '#{pane_current_command}\t#{pane_current_path}')
TARGET_FORMAT = '#{session_name}:#{window_index}.#{pane_index}'
SEND_PAUSE_SECONDS = 0.2
# After Enter, look at the input box this long after each press; press again while our text is still there.
SUBMIT_CHECK_SECONDS = (0.5, 1.0, 2.0)
SUBMIT_CAPTURE_LINES = 40
SUBMIT_TAIL_CHARS = 24
INPUT_RULE = re.compile('^\\s*─{10,}\\s*$')
PROMPT_MARK = '❯'
START_WATCH_SECONDS = 20.0
STOP_GRACE_SECONDS = 10.0
WATCH_INTERVAL_SECONDS = 0.5
TMUX_TIMEOUT_SECONDS = 10.0
VERSIONED_CLAUDE_EXE = re.compile(r'.*/claude/versions/[^/]+', re.ASCII)
TMUX_VERSION = re.compile(r'tmux (?:next-)?([0-9]+)\.([0-9]+)', re.ASCII)


class TmuxError(Exception):
    """A tmux command exited non-zero."""


@dataclass(frozen=True)
class Pane:
    target: str
    session: str
    pane_pid: int
    command: str
    cwd: str


def exact(target: str) -> str:
    """Prefix '=' so tmux matches the session name exactly (by default tmux also accepts a unique prefix)."""
    return target if target.startswith(('=', '%', '$', '@')) else f'={target}'


def parse_pane(line: str) -> Pane | None:
    parts = line.split('\t', 4)
    if len(parts) != 5 or not parts[2].isdigit():
        return None
    return Pane(target=parts[0], session=parts[1], pane_pid=int(parts[2]), command=parts[3], cwd=parts[4])


class Tmux:
    """Thin argv-only tmux wrapper. `run` has the signature of common.run_process."""

    def __init__(self, run: Callable[..., RunResult] = common.run_process, binary: str = 'tmux') -> None:
        self._run = run
        self._binary = binary

    def call(self, args: list[str], input_bytes: bytes | None = None, check: bool = True) -> RunResult:
        result = self._run([self._binary, *args], input_bytes=input_bytes, timeout=TMUX_TIMEOUT_SECONDS)
        if check and result.code != 0:
            detail = result.stderr.decode('utf-8', 'replace').strip()
            raise TmuxError(f'tmux {args[0]} failed ({result.code}): {detail}')
        return result

    def version(self) -> tuple[int, int] | None:
        match = TMUX_VERSION.search(self.call(['-V'], check=False).text)
        return (int(match.group(1)), int(match.group(2))) if match else None

    def list_panes(self) -> list[Pane]:
        result = self.call(['list-panes', '-a', '-F', PANE_FORMAT], check=False)
        if result.code != 0:
            return []
        return [pane for pane in map(parse_pane, result.text.splitlines()) if pane is not None]

    def display(self, target: str, fmt: str) -> str | None:
        result = self.call(['display-message', '-p', '-t', target, fmt], check=False)
        return result.text.rstrip('\n') if result.code == 0 else None

    def pane(self, target: str) -> Pane | None:
        text = self.display(exact(target), PANE_FORMAT)
        return parse_pane(text) if text else None

    def has_session(self, name: str) -> bool:
        return self.call(['has-session', '-t', f'={name}'], check=False).code == 0

    def send_keys(self, target: str, *keys: str) -> None:
        self.call(['send-keys', '-t', exact(target), *keys])

    def send_literal(self, target: str, text: str) -> None:
        self.call(['send-keys', '-t', exact(target), '-l', text])

    def send_literal_line(self, target: str, line: str) -> None:
        """Type one line literally. `--` protects a leading '-'; each trailing ';' goes as its own escaped argument.

        tmux treats an argument ending in ';' as a command separator, and ends up dropping or splitting it.
        """
        body = line.rstrip(';')
        semicolons = len(line) - len(body)
        if body:
            self.call(['send-keys', '-t', exact(target), '-l', '--', body])
        for _ in range(semicolons):
            self.call(['send-keys', '-t', exact(target), '-l', '--', '\\;'])

    def capture(self, target: str, lines: int) -> str:
        return self.call(['capture-pane', '-p', '-t', exact(target), '-S', f'-{lines}']).text

    def new_session(self, name: str, cwd: str, argv: list[str]) -> None:
        self.call(['new-session', '-d', '-s', name, '-c', cwd, '--', *argv])

    def kill_pane(self, target: str) -> None:
        self.call(['kill-pane', '-t', exact(target)])

    def respawn_pane(self, target: str, cwd: str, argv: list[str]) -> None:
        self.call(['respawn-pane', '-k', '-t', exact(target), '-c', cwd, '--', *argv])

    def set_remain_on_exit(self, target: str, enabled: bool) -> None:
        option = ['remain-on-exit', 'on'] if enabled else ['remain-on-exit']
        flags = ['-w'] if enabled else ['-w', '-u']
        self.call(['set-option', *flags, '-t', exact(target), *option], check=False)


def _children_map(proc_root: str) -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return children
    for entry in entries:
        fields = common.read_proc_stat(int(entry), proc_root) if entry.isdigit() else None
        if fields and len(fields) > 1 and fields[1].isdigit():
            children.setdefault(int(fields[1]), []).append(int(entry))
    return children


def pane_tree(root_pid: int, proc_root: str = '/proc') -> list[int]:
    """root_pid and its descendants (bounded to 512 processes)."""
    children, seen, queue = _children_map(proc_root), [], [root_pid]
    while queue and len(seen) < 512:
        pid = queue.pop(0)
        if pid not in seen:
            seen.append(pid)
            queue.extend(children.get(pid, []))
    return seen


def is_claude_process(pid: int, proc_root: str = '/proc') -> bool:
    try:
        raw = Path(proc_root, str(pid), 'cmdline').read_bytes()
    except OSError:
        raw = b''
    if os.path.basename(raw.split(b'\0', 1)[0].decode('utf-8', 'replace')) == 'claude':
        return True
    try:
        exe = os.readlink(os.path.join(proc_root, str(pid), 'exe'))
    except OSError:
        return False
    return VERSIONED_CLAUDE_EXE.fullmatch(exe) is not None


def is_claude_pane(pane: Pane, proc_root: str = '/proc') -> bool:
    """A Claude pane: pane_current_command is `claude`, or a process in the pane tree has argv[0] basename `claude`.

    Also matches the native installer's version-named binary.
    """
    if pane.command == 'claude':
        return True
    return any(is_claude_process(pid, proc_root) for pid in pane_tree(pane.pane_pid, proc_root))


@contextlib.contextmanager
def _flocked(path: Path) -> Iterator[None]:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def send_text(tmux: Tmux, lock_path: Path, target: str, text: str, sleep: Callable[[float], None]) -> None:
    """Send without bracketed paste (Claude Code 2.1.296 wraps 4+ line pastes):
    - Every line is typed with `send-keys -l -- <line>` (empty lines send nothing).
    - `S-Enter` (newline in the input box) goes between lines and a final `Enter` submits.
    - A flock serializes sends, so two concurrent sends never interleave in a pane.
    """
    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    with _flocked(lock_path):
        for index, line in enumerate(lines):
            if index:
                tmux.send_keys(target, 'S-Enter')
            if line:
                tmux.send_literal_line(target, line)
        sleep(SEND_PAUSE_SECONDS)
        tmux.send_keys(target, 'Enter')
        _confirm_submitted(tmux, target, text, sleep)


def input_box_text(screen: str) -> str | None:
    """Claude Code's input box (between the last two horizontal rules) with all whitespace removed; None if not on screen."""
    lines = screen.splitlines()
    rules = [index for index, line in enumerate(lines) if INPUT_RULE.match(line)]
    if len(rules) < 2:
        return None
    body = ''.join(lines[rules[-2] + 1:rules[-1]]).replace(PROMPT_MARK, '', 1)
    return re.sub(r'\s+', '', body)


def still_unsent(screen: str, text: str) -> bool:
    """True while the input box still ends with the last line we typed (Enter was read as a newline, not a submit)."""
    box = input_box_text(screen)
    last = next((line for line in reversed(text.splitlines()) if line.strip()), '')
    tail = re.sub(r'\s+', '', last)[-SUBMIT_TAIL_CHARS:]
    return bool(box) and bool(tail) and box.endswith(tail)


def _confirm_submitted(tmux: Tmux, target: str, text: str, sleep: Callable[[float], None]) -> None:
    """Claude Code can read an Enter that lands while it is still redrawing the typed text as part of that text, so
    the message stays in the input box. Press Enter again (at most three times) while our own text is still there.
    """
    for wait in SUBMIT_CHECK_SECONDS:
        sleep(wait)
        try:
            screen = tmux.capture(target, SUBMIT_CAPTURE_LINES)
        except TmuxError:
            return
        if not still_unsent(screen, text):
            return
        tmux.send_keys(target, 'Enter')


def _require_pane(tmux: Tmux, target: str) -> Pane:
    pane = tmux.pane(target)
    if pane is None:
        raise CtlError('not_found', f'no tmux pane {target}')
    return pane


def _require_claude(pane: Pane, ctx: 'Ctx') -> None:
    if not is_claude_pane(pane, ctx.proc_root):
        raise CtlError('refused', f'pane {pane.target} is not running claude (it runs {pane.command!r})')


def pending_qid_for(ctx: 'Ctx', target: str) -> str | None:
    """qid of a live pending question or permission on that pane (dead waiters are reaped first)."""
    host = common.load_config(ctx.paths)['host_alias']
    for entry in common.live_pending(ctx.paths, host, ctx.now(), ctx.proc_root):
        if entry.get('tmux') == target:
            return entry['qid']
    return None


def _read_prompt_text(kit_io: 'KitIO', required: bool) -> str:
    text = kit_io.read_text(common.SEND_TEXT_MAX * 4)
    if len(text) > common.SEND_TEXT_MAX:
        raise CtlError('usage', f'text exceeds {common.SEND_TEXT_MAX} characters')
    if '\x00' in text:
        raise CtlError('usage', 'text contains a NUL character')
    if required and not text.strip():
        raise CtlError('usage', 'text on stdin is empty')
    return text


def cmd_send(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    text = _read_prompt_text(kit_io, required=True)
    tmux = Tmux(ctx.run)
    _require_claude(_require_pane(tmux, ns.target), ctx)
    qid = pending_qid_for(ctx, ns.target)
    if qid is not None:
        raise CtlError('refused', f'question pending: {qid}')
    send_text(tmux, ctx.paths.state / 'send.lock', ns.target, text, ctx.sleep)
    return {'ok': True}


def cmd_keys(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    tmux = Tmux(ctx.run)
    _require_pane(tmux, ns.target)
    tmux.send_keys(ns.target, ns.key)
    return {'ok': True}


def cmd_capture(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    tmux = Tmux(ctx.run)
    _require_pane(tmux, ns.target)
    lines = tmux.capture(ns.target, ns.lines).splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return {'text': '\n'.join(lines[-ns.lines:])}


def claude_argv(claude_bin: str, model: str | None, resume: str | None, prompt: str | None,
                remote_control: str | None = None) -> list[str]:
    """The claude argv. A prompt that starts with '-' gets a leading space so claude never parses it as a flag."""
    model_args = ['--model', model] if model else []
    resume_args = ['--resume', resume] if resume else []
    rc_args = ['--remote-control', remote_control] if remote_control else []
    prompt_args = [(' ' + prompt) if prompt.startswith('-') else prompt] if prompt else []
    return [claude_bin, '--permission-mode', 'bypassPermissions', *model_args, *resume_args, *rc_args, *prompt_args]


def remote_control_name(ctx: 'Ctx', session: str) -> str:
    """How the session is listed in the Claude app (Remote Control): `cedar · meadow-hr`."""
    project = session[3:] if session.startswith('cc-') else session
    return f"{common.load_config(ctx.paths)['host_alias']} · {project}"


def _under(path: str, root: str) -> bool:
    base = '/' + os.path.normpath(root).lstrip('/')
    return path.startswith(base.rstrip('/') + '/')


def _registered_since(ctx: 'Ctx', target: str, started: datetime) -> bool:
    entry = common.registry_for_target(common.list_registry(ctx.paths), target, None)
    return entry is not None and str(entry.get('started_at') or '') >= common.iso_utc(started)


def _answer_trust_dialog(tmux: Tmux, target: str, screen: str) -> None:
    """Claude Code 2.1.296 preselects "No, exit": Enter is pressed only while the cursor is on "Yes"."""
    selected = next((line for line in screen.splitlines() if '\u276f' in line), '')
    tmux.send_keys(target, 'Enter' if 'yes' in selected.lower() else 'Down')


def watch_startup(tmux: Tmux, ctx: 'Ctx', target: str, started: datetime) -> None:
    """Watch for up to 20 s:
    - return once the SessionStart hook has registered the pane;
    - answer a folder-trust dialog ("trust" and "folder" on screen) by moving to "Yes" and confirming it;
    - fail if the session dies.
    """
    deadline = ctx.monotonic() + START_WATCH_SECONDS
    while ctx.monotonic() < deadline:
        if _registered_since(ctx, target, started):
            return
        if tmux.pane(target) is None:
            raise CtlError('failed', f'session {target} exited during startup')
        screen = tmux.capture(target, 60)
        if 'trust' in screen.lower() and 'folder' in screen.lower():
            _answer_trust_dialog(tmux, target, screen)
        ctx.sleep(WATCH_INTERVAL_SECONDS)


def _session_target(tmux: Tmux, session: str) -> str:
    """First pane of a session as `name:W.P` (a bare `=name` does not resolve as a pane target)."""
    result = tmux.call(['list-panes', '-t', f'={session}', '-F', TARGET_FORMAT], check=False)
    first = result.text.splitlines()[0] if result.code == 0 and result.text.strip() else ''
    return first or f'{session}:0.0'


def cmd_start(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    prompt = _read_prompt_text(kit_io, required=False)
    if not _under(ns.cwd, ctx.projects_root) or not os.path.isdir(ns.cwd):
        raise CtlError('refused', f'cwd must be an existing directory under {ctx.projects_root}')
    session = 'cc-' + ns.name.replace('.', '_')
    tmux = Tmux(ctx.run)
    if tmux.has_session(session):
        raise CtlError('refused', f'tmux session {session} already exists')
    started = ctx.now()
    argv = claude_argv(str(ctx.paths.claude_bin), ns.model, ns.resume, prompt if prompt.strip() else None,
                       remote_control_name(ctx, session))
    tmux.new_session(session, ns.cwd, argv)
    target = _session_target(tmux, session)
    watch_startup(tmux, ctx, target, started)
    return {'ok': True, 'target': target}


def _stopped(tmux: Tmux, ctx: 'Ctx', target: str) -> bool:
    pane = tmux.pane(target)
    if pane is None or tmux.display(exact(target), '#{pane_dead}') == '1':
        return True
    return not is_claude_pane(pane, ctx.proc_root)


def graceful_exit(tmux: Tmux, ctx: 'Ctx', target: str, grace: float = STOP_GRACE_SECONDS) -> bool:
    """Escape, then /exit + Enter. True once claude has left the pane within `grace` seconds."""
    try:
        tmux.send_keys(target, 'Escape')
        ctx.sleep(0.3)
        tmux.send_literal(target, '/exit')
        ctx.sleep(0.2)
        tmux.send_keys(target, 'Enter')
    except TmuxError:
        return _stopped(tmux, ctx, target)
    deadline = ctx.monotonic() + grace
    while ctx.monotonic() < deadline:
        if _stopped(tmux, ctx, target):
            return True
        ctx.sleep(WATCH_INTERVAL_SECONDS)
    return False


def stop_pane(tmux: Tmux, ctx: 'Ctx', target: str, force: bool, grace: float = STOP_GRACE_SECONDS) -> bool:
    """Stop claude in a pane. Returns True when the pane had to be killed."""
    if not force and graceful_exit(tmux, ctx, target, grace):
        return False
    if tmux.pane(target) is not None:
        tmux.kill_pane(target)
    return True


def cmd_stop(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    tmux = Tmux(ctx.run)
    pane = _require_pane(tmux, ns.target)
    if not ns.force and not is_claude_pane(pane, ctx.proc_root):
        raise CtlError('refused', f'pane {ns.target} is not running claude; use --force to kill it')
    return {'ok': True, 'forced': stop_pane(tmux, ctx, ns.target, ns.force)}


def cmd_restart(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    tmux = Tmux(ctx.run)
    pane = _require_pane(tmux, ns.target)
    entry = common.registry_for_target(common.list_registry(ctx.paths), ns.target, pane.pane_pid)
    if entry is None:
        raise CtlError('not_found', f'no registered claude session for {ns.target}')
    cwd = common.as_str(entry.get('cwd')) or pane.cwd
    argv = claude_argv(str(ctx.paths.claude_bin), None, entry['session_id'], None,
                       remote_control_name(ctx, ns.target.split(':')[0]))
    tmux.set_remain_on_exit(ns.target, True)
    try:
        if is_claude_pane(pane, ctx.proc_root):
            graceful_exit(tmux, ctx, ns.target)
        tmux.respawn_pane(ns.target, cwd, argv)
    finally:
        tmux.set_remain_on_exit(ns.target, False)
    return {'ok': True}
