"""Claude Code hook entrypoint for the Luady kit.

It normalizes hook events into the spool, keeps the session registry, runs the hourly cleanup and handles
remote answering. It never breaks the session: any failure prints nothing, exits 0 and is logged to
~/.luady/state/hook-errors.log.
"""
from __future__ import annotations

import contextlib
import json
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO, Callable, Iterator, Mapping

from . import common
from .common import CtlError
from .tmuxio import Tmux

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

SIMPLE_EVENTS = {
    'SessionStart': 'session_start', 'UserPromptSubmit': 'prompt', 'Stop': 'stop',
    'StopFailure': 'stop_failure', 'Notification': 'notification', 'SessionEnd': 'session_end',
}
ASYNC_EVENTS = frozenset({'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'})
STDIN_MAX_BYTES = 16 * 1024 * 1024
CLEANUP_INTERVAL_SECONDS = 3600
SPOOL_RETENTION_DAYS = 7
TRASH_RETENTION_SECONDS = 7 * 86400
REGISTRY_RETENTION_SECONDS = 30 * 86400
ORPHAN_ANSWER_SECONDS = 3600


@dataclass(frozen=True)
class HookEnv:
    """The hook's view of the world; tests replace any part."""

    paths: common.KitPaths
    tmux: Tmux
    environ: Mapping[str, str]
    now: Callable[[], datetime] = common.utc_now
    sleep: Callable[[float], None] = time.sleep
    monotonic: Callable[[], float] = time.monotonic
    getppid: Callable[[], int] = os.getppid
    poll_interval: float = 1.0
    proc_root: str = '/proc'


def default_env() -> HookEnv:
    return HookEnv(paths=common.KitPaths.from_env(), tmux=Tmux(), environ=os.environ)


def main(*, stdin: BinaryIO | None = None, stdout: BinaryIO | None = None, env: HookEnv | None = None) -> int:
    """Hook entrypoint. Always returns 0. It prints a decision only for an answered question or permission."""
    hook_env = env if env is not None else default_env()
    try:
        raw = (stdin if stdin is not None else sys.stdin.buffer).read(STDIN_MAX_BYTES)
        output = handle(raw, hook_env)
    except BaseException as exc:  # noqa: BLE001 - a hook must never break the Claude session
        common.log_hook_error(hook_env.paths, f'hook failed: {type(exc).__name__}: {exc}')
        return 0
    if output is not None:
        _write_output(stdout if stdout is not None else sys.stdout.buffer, output, hook_env.paths)
    return 0


def _write_output(out: BinaryIO, output: dict[str, Any], paths: common.KitPaths) -> None:
    try:
        out.write(json.dumps(output, ensure_ascii=False).encode('utf-8'))
        out.flush()
    except OSError as exc:
        common.log_hook_error(paths, f'could not write hook output: {exc}')


def handle(raw: bytes, env: HookEnv) -> dict[str, Any] | None:
    payload = json.loads(raw.decode('utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('hook input is not a JSON object')
    name = payload.get('hook_event_name')
    cfg = common.load_config(env.paths)
    if name in ASYNC_EVENTS:
        run_cleanup(env, cfg)
    if name in SIMPLE_EVENTS:
        record_simple_event(env, cfg, payload, name)
    elif name == 'PreToolUse' and payload.get('tool_name') == 'AskUserQuestion':
        return remote_question(env, cfg, payload)
    elif name == 'PermissionRequest':
        return remote_permission(env, cfg, payload)
    return None


def tmux_location(env: HookEnv) -> tuple[str | None, int | None]:
    """(target, pane_pid) of the pane running this hook, from $TMUX_PANE; (None, None) outside tmux."""
    pane_id = env.environ.get('TMUX_PANE')
    if not pane_id:
        return None, None
    text = env.tmux.display(pane_id, '#S:#I.#P\t#{pane_pid}')
    if not text:
        return None, None
    target, _, pid = text.partition('\t')
    return (target or None), (int(pid) if pid.isdigit() else None)


def event_meta(payload: Mapping[str, Any], target: str | None) -> dict[str, Any]:
    return {'session_id': payload.get('session_id'), 'cwd': payload.get('cwd'),
            'transcript_path': payload.get('transcript_path'), 'permission_mode': payload.get('permission_mode'),
            'tmux': target}


def _text(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    return value if isinstance(value, str) else ''


def _model_name(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        for key in ('id', 'display_name', 'name'):
            if isinstance(value.get(key), str) and value[key]:
                return value[key]
    return None


def norm_session_start(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {'source': _text(payload, 'source') or 'unknown', 'model': _model_name(payload.get('model'))}


def norm_prompt(payload: Mapping[str, Any]) -> dict[str, Any]:
    prompt = _text(payload, 'prompt')
    return {'prompt_sha256': common.prompt_hash(prompt),
            'prompt_preview': common.truncate_chars(prompt, common.PROMPT_PREVIEW_MAX)[0]}


def norm_stop(payload: Mapping[str, Any]) -> dict[str, Any]:
    text, cut = common.truncate_chars(_text(payload, 'last_assistant_message'), common.LAST_ASSISTANT_MESSAGE_MAX)
    return {'last_assistant_message': text, 'truncated': cut}


def norm_stop_failure(payload: Mapping[str, Any]) -> dict[str, Any]:
    parts: list[str] = []
    for key in ('error', 'error_details', 'last_assistant_message'):
        value = _text(payload, key).strip()
        if value and value not in parts:
            parts.append(value)
    joined = ' — '.join(parts) or 'unknown'
    return {'error': common.truncate_chars(joined, common.STOP_FAILURE_ERROR_MAX)[0]}


def norm_notification(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {'notification_type': _text(payload, 'notification_type') or 'unknown',
            'message': common.truncate_chars(_text(payload, 'message'), common.NOTIFICATION_MESSAGE_MAX)[0],
            'title': _text(payload, 'title') or None}


def norm_session_end(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {'reason': _text(payload, 'reason') or 'other'}


NORMALIZERS: dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]] = {
    'SessionStart': norm_session_start, 'UserPromptSubmit': norm_prompt, 'Stop': norm_stop,
    'StopFailure': norm_stop_failure, 'Notification': norm_notification, 'SessionEnd': norm_session_end,
}


def append(env: HookEnv, cfg: Mapping[str, Any], event: str, meta: Mapping[str, Any], data: dict[str, Any]) -> None:
    common.append_event(env.paths, common.build_record(event, cfg['host_alias'], meta, data, env.now()))


def record_simple_event(env: HookEnv, cfg: Mapping[str, Any], payload: Mapping[str, Any], name: str) -> None:
    target, pane_pid = tmux_location(env)
    if name == 'SessionStart':
        write_session_registry(env, payload, target, pane_pid)
    append(env, cfg, SIMPLE_EVENTS[name], event_meta(payload, target), NORMALIZERS[name](payload))
    sid = payload.get('session_id')
    if name == 'SessionEnd' and common.matches(common.SID_RE, sid):
        common.remove_registry(env.paths, sid)


def write_session_registry(env: HookEnv, payload: Mapping[str, Any], target: str | None,
                           pane_pid: int | None) -> None:
    sid = payload.get('session_id')
    if not common.matches(common.SID_RE, sid):
        common.log_hook_error(env.paths, f'SessionStart with invalid session_id {sid!r}; registry not written')
        return
    common.write_registry(env.paths, {
        'session_id': sid, 'transcript_path': common.as_str(payload.get('transcript_path')),
        'cwd': common.as_str(payload.get('cwd')), 'tmux': target, 'source': _text(payload, 'source') or 'unknown',
        'started_at': common.iso_utc(env.now()), 'pane_pid': pane_pid,
    })


def run_cleanup(env: HookEnv, cfg: Mapping[str, Any]) -> None:
    """At most once per hour:
    - purge spool days and trash older than 7 days, stale registry entries and orphan answers;
    - reap dead waiters.
    """
    try:
        if not _cleanup_due(env):
            return
        _purge_spool(env)
        _purge_older(env.paths.trash, TRASH_RETENTION_SECONDS, env)
        _purge_older(env.paths.registry, REGISTRY_RETENTION_SECONDS, env)
        _purge_orphan_answers(env)
        common.reap_dead_pending(env.paths, cfg['host_alias'], env.now(), env.proc_root)
    except Exception as exc:  # noqa: BLE001 - cleanup problems are logged, never raised into the session
        common.log_hook_error(env.paths, f'cleanup failed: {type(exc).__name__}: {exc}')


def _cleanup_due(env: HookEnv) -> bool:
    marker = env.paths.state / 'last_cleanup'
    now_ts = env.now().timestamp()
    if marker.exists() and now_ts - marker.stat().st_mtime < CLEANUP_INTERVAL_SECONDS:
        return False
    marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker.write_text(common.iso_utc(env.now()) + '\n', encoding='utf-8')
    os.utime(marker, (now_ts, now_ts))
    return True


def _purge_spool(env: HookEnv) -> None:
    cutoff = common.utc_day(env.now() - timedelta(days=SPOOL_RETENTION_DAYS))
    for path in env.paths.spool.glob('events-*.jsonl'):
        match = common.SPOOL_FILE_RE.fullmatch(path.name)
        if match and match.group(1) < cutoff:
            path.unlink(missing_ok=True)


def _purge_older(directory: Path, max_age: int, env: HookEnv) -> None:
    cutoff = env.now().timestamp() - max_age
    for path in directory.glob('*'):
        if path.is_file() and path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)


def _purge_orphan_answers(env: HookEnv) -> None:
    cutoff = env.now().timestamp() - ORPHAN_ANSWER_SECONDS
    for path in env.paths.answers.glob('*.json'):
        if not common.pending_path(env.paths, path.stem).exists() and path.stat().st_mtime < cutoff:
            path.unlink(missing_ok=True)


# --- remote answering: the hook side and the luady-ctl side of the pending/answer protocol ---

ANSWER_STDIN_MAX = 1024 * 1024


class Cancelled(Exception):
    """Raised by a signal handler while a question or permission waits for its answer."""


@contextlib.contextmanager
def _cancel_on_signals() -> Iterator[None]:
    def _raise(signum: int, _frame: Any) -> None:
        raise Cancelled(f'signal {signum}')

    previous = {}
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        try:
            previous[signum] = signal.signal(signum, _raise)
        except ValueError:  # not the main thread (tests run hooks in threads): keep the current handlers
            continue
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


TURN_END_EVENTS = ('stop', 'stop_failure', 'session_end')


class _TurnEndWatch:
    """Notices that the session's turn ended while a hook still waits (a locally answered dialog does not signal the
    waiting PermissionRequest hook, so without this it would wait for hook_wait_seconds)."""

    def __init__(self, env: HookEnv, session_id: str | None) -> None:
        self._env, self._sid = env, session_id
        self._file, self._offset = None, 0
        self._prime()

    def _today(self) -> Path:
        return self._env.paths.spool / f'events-{common.utc_day(self._env.now())}.jsonl'

    def _prime(self) -> None:
        self._file = self._today()
        try:
            self._offset = self._file.stat().st_size
        except OSError:
            self._offset = 0

    def ended(self) -> bool:
        if not self._sid:
            return False
        path = self._today()
        if path != self._file:
            self._file, self._offset = path, 0
        try:
            with open(path, 'rb') as handle:
                handle.seek(self._offset)
                chunk = handle.read()
        except OSError:
            return False
        end = chunk.rfind(b'\n') + 1
        self._offset += end
        for raw in chunk[:end].splitlines():
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            if (isinstance(event, dict) and event.get('session_id') == self._sid
                    and event.get('event') in TURN_END_EVENTS):
                return True
        return False


def wait_for_answer(env: HookEnv, qid: str, wait_seconds: int, session_id: str | None = None) -> tuple[str, Any]:
    """Poll answers/<qid>.json every poll_interval.

    Returns one of:
    - ('answer', obj)
    - ('invalid', None)
    - ('timeout', None)
    - ('cancelled', None): the parent process (Claude Code) went away, or the session's turn ended (Stop,
      StopFailure or SessionEnd was spooled) so the dialog was answered locally.
    """
    path = common.answer_path(env.paths, qid)
    start, parent = env.monotonic(), env.getppid()
    watch = _TurnEndWatch(env, session_id)
    limit = min(wait_seconds, common.HOOK_WAIT_MAX_SECONDS)
    with _cancel_on_signals():
        while True:
            if path.exists():
                answer = common.read_json_or_none(path)
                return ('answer', answer) if answer is not None else ('invalid', None)
            if env.getppid() != parent or watch.ended():
                return 'cancelled', None
            if env.monotonic() - start >= limit:
                return 'timeout', None
            env.sleep(env.poll_interval)


def _is_release(answer: Any) -> bool:
    return isinstance(answer, dict) and set(answer) == {'release'} and answer['release'] is True


def valid_answers(answer: Any, questions: list[Any]) -> dict[str, str] | None:
    """{"answers": {question text: str}} using only known question texts; otherwise None."""
    if not isinstance(answer, dict) or set(answer) != {'answers'} or not isinstance(answer['answers'], dict):
        return None
    texts = {q.get('question') for q in questions if isinstance(q, dict)}
    answers = answer['answers']
    ok = bool(answers) and all(isinstance(k, str) and k in texts and isinstance(v, str) for k, v in answers.items())
    return dict(answers) if ok else None


def valid_permission(answer: Any) -> dict[str, str] | None:
    """{"behavior": "allow"|"deny", "message"?: str} → the decision object (message kept only for deny)."""
    if not isinstance(answer, dict) or 'behavior' not in answer or not set(answer) <= {'behavior', 'message'}:
        return None
    behavior, message = answer['behavior'], answer.get('message')
    if behavior not in ('allow', 'deny') or ('message' in answer and not isinstance(message, str)):
        return None
    return {'behavior': 'deny', 'message': message} if behavior == 'deny' and message else {'behavior': behavior}


def _clean_option(option: dict[str, Any]) -> dict[str, Any]:
    clean = {k: v for k, v in option.items() if k != 'description'}
    return {**clean, 'description': option['description']} if isinstance(option.get('description'), str) else clean


def _clean_question(question: dict[str, Any]) -> dict[str, Any]:
    """Shape one question for AskQuestionSchema (optional fields only when they have the right type)."""
    base = {k: v for k, v in question.items() if k not in ('header', 'multiSelect', 'options')}
    header = {'header': question['header']} if isinstance(question.get('header'), str) else {}
    multi = {'multiSelect': question['multiSelect']} if isinstance(question.get('multiSelect'), bool) else {}
    options = question.get('options') if isinstance(question.get('options'), list) else []
    kept = [_clean_option(o) for o in options if isinstance(o, dict) and isinstance(o.get('label'), str)]
    return {**base, **header, **multi, 'options': kept}


def valid_questions(tool_input: Any) -> list[dict[str, Any]] | None:
    questions = tool_input.get('questions') if isinstance(tool_input, dict) else None
    if not isinstance(questions, list) or not questions:
        return None
    if not all(isinstance(q, dict) and isinstance(q.get('question'), str) and q['question'] for q in questions):
        return None
    return [_clean_question(q) for q in questions]


def permission_preview(tool_input: Any) -> str:
    if isinstance(tool_input, dict) and isinstance(tool_input.get('command'), str):
        text = tool_input['command']
    else:
        text = json.dumps(tool_input, ensure_ascii=False, sort_keys=True, default=str)
    return common.truncate_chars(text, common.PERMISSION_INPUT_PREVIEW_MAX)[0]


def decide_question(status: str, answer: Any, tool_input: dict[str, Any],
                    questions: list[dict[str, Any]]) -> tuple[str, dict[str, Any] | None]:
    if status in ('timeout', 'cancelled'):
        return ('timeout' if status == 'timeout' else 'released'), None
    if _is_release(answer):
        return 'released', None
    answers = valid_answers(answer, questions)
    if answers is None:
        return 'error', None
    updated = {**tool_input, 'answers': answers}
    return 'answered', {'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow',
                                               'updatedInput': updated}}


def decide_permission(status: str, answer: Any) -> tuple[str, dict[str, Any] | None]:
    if status in ('timeout', 'cancelled'):
        return ('timeout' if status == 'timeout' else 'released'), None
    if _is_release(answer):
        return 'released', None
    decision = valid_permission(answer)
    if decision is None:
        return 'error', None
    outcome = 'allowed' if decision['behavior'] == 'allow' else 'denied'
    return outcome, {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': decision}}


def create_pending(env: HookEnv, kind: str, meta: dict[str, Any], payload: dict[str, Any]) -> str:
    common.ensure_runtime_dirs(env.paths)
    pid = os.getpid()
    for _ in range(16):
        qid = common.new_qid()
        if common.answer_path(env.paths, qid).exists():
            continue
        entry = {'qid': qid, 'kind': kind, 'created_at': common.iso_utc(env.now()),
                 'session_id': common.as_str(meta.get('session_id')), 'tmux': common.as_str(meta.get('tmux')),
                 'payload': payload, 'meta': {k: common.as_str(v) for k, v in meta.items()},
                 'pid': pid, 'pid_start': common.proc_start_ticks(pid, env.proc_root)}
        if common.exclusive_write_json(common.pending_path(env.paths, qid), entry):
            return qid
    raise RuntimeError('could not allocate a unique qid')


def finish_pending(env: HookEnv, cfg: Mapping[str, Any], kind: str, qid: str, meta: Mapping[str, Any],
                   outcome: str) -> None:
    """Remove the pending and answer files. Only the caller that removed the pending file emits <kind>_resolved."""
    try:
        claimed = common.claim_pending(env.paths, qid)
        common.remove_answer(env.paths, qid)
        if claimed:
            append(env, cfg, f'{kind}_resolved', meta, {'qid': qid, 'outcome': outcome})
    except Exception as exc:  # noqa: BLE001 - resolution problems are logged, never raised into the session
        common.log_hook_error(env.paths, f'could not resolve {qid}: {type(exc).__name__}: {exc}')


def remote_wait(env: HookEnv, cfg: Mapping[str, Any], meta: dict[str, Any], kind: str,
                pending_payload: dict[str, Any], event_data: dict[str, Any],
                decide: Callable[[str, Any], tuple[str, dict[str, Any] | None]]) -> dict[str, Any] | None:
    qid = create_pending(env, kind, meta, pending_payload)
    outcome, output = 'error', None
    try:
        append(env, cfg, kind, meta, {'qid': qid, **event_data})
        status, answer = wait_for_answer(env, qid, cfg['hook_wait_seconds'], common.as_str(meta.get('session_id')))
        outcome, output = decide(status, answer)
    except Cancelled:
        outcome, output = 'released', None
    finally:
        finish_pending(env, cfg, kind, qid, meta, outcome)
    return output


def remote_question(env: HookEnv, cfg: Mapping[str, Any], payload: Mapping[str, Any]) -> dict[str, Any] | None:
    if not cfg['remote_answering']:
        return None
    tool_input = payload.get('tool_input')
    questions = valid_questions(tool_input)
    if questions is None:
        common.log_hook_error(env.paths, 'AskUserQuestion with no usable questions; left to the terminal')
        return None
    meta = event_meta(payload, tmux_location(env)[0])
    tool_use_id = common.as_str(payload.get('tool_use_id'))
    return remote_wait(env, cfg, meta, 'question', {'questions': questions, 'tool_use_id': tool_use_id},
                       {'tool_use_id': tool_use_id, 'questions': questions},
                       lambda status, answer: decide_question(status, answer, tool_input, questions))


def remote_permission(env: HookEnv, cfg: Mapping[str, Any], payload: Mapping[str, Any]) -> dict[str, Any] | None:
    if not cfg['remote_answering']:
        return None
    if payload.get('tool_name') == 'AskUserQuestion':
        # Claude Code fires PermissionRequest for AskUserQuestion after the PreToolUse hook released or timed out.
        # That question was already offered remotely, so it is left to the terminal dialog.
        return None
    meta = event_meta(payload, tmux_location(env)[0])
    tool_name = _text(payload, 'tool_name') or 'unknown'
    tool_input = payload.get('tool_input')
    return remote_wait(env, cfg, meta, 'permission', {'tool_name': tool_name, 'tool_input': tool_input},
                       {'tool_name': tool_name, 'input_preview': permission_preview(tool_input)}, decide_permission)


def _live_entry(ctx: 'Ctx', qid: str, kind: str) -> dict[str, Any]:
    host = common.load_config(ctx.paths)['host_alias']
    for entry in common.live_pending(ctx.paths, host, ctx.now(), ctx.proc_root):
        if entry['qid'] == qid:
            if entry['kind'] != kind:
                raise CtlError('not_found', f'{qid} is a {entry["kind"]}, not a {kind}')
            return entry
    raise CtlError('not_found', f'no pending {kind} {qid}')


def _write_answer(ctx: 'Ctx', qid: str, body: Any) -> None:
    common.ensure_runtime_dirs(ctx.paths)
    if not common.exclusive_write_json(common.answer_path(ctx.paths, qid), body):
        raise CtlError('refused', f'{qid} already has an answer')


def cmd_pending(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    host = common.load_config(ctx.paths)['host_alias']
    items = [{'qid': e['qid'], 'kind': e['kind'], 'created_at': common.as_str(e.get('created_at')) or '',
              'session_id': common.as_str(e.get('session_id')), 'tmux': common.as_str(e.get('tmux'))}
             for e in common.live_pending(ctx.paths, host, ctx.now(), ctx.proc_root)]
    return {'pending': sorted(items, key=lambda item: item['created_at'])}


def cmd_answer(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    body = kit_io.read_json(ANSWER_STDIN_MAX)
    entry = _live_entry(ctx, ns.qid, 'question')
    payload = entry['payload'] if isinstance(entry.get('payload'), dict) else {}
    questions = payload['questions'] if isinstance(payload.get('questions'), list) else []
    if not _is_release(body) and valid_answers(body, questions) is None:
        raise CtlError('usage', 'expected {"answers": {<question text>: <answer>}} using the pending question '
                                'texts, or {"release": true}')
    _write_answer(ctx, ns.qid, body)
    return {'ok': True}


def cmd_permission(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    body = kit_io.read_json(ANSWER_STDIN_MAX)
    _live_entry(ctx, ns.qid, 'permission')
    if not _is_release(body) and valid_permission(body) is None:
        raise CtlError('usage', 'expected {"behavior": "allow"|"deny", "message"?: string} or {"release": true}')
    _write_answer(ctx, ns.qid, body)
    return {'ok': True}
