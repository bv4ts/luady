"""Tool steps and helpers as short, redacted activity events (kit 2).

Pure functions turn one Claude Code hook input (PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart,
SubagentStop) into one activity spool event (`packages/shared/src/activity.ts`).
A summary holds a tool name, a title of at most 160 UTF-16 code units, line counts, to-do items, ok or failed and
helper ids. Never file contents, never command output, never tool input beyond what the title rules name.
"""
from __future__ import annotations

import hashlib
import json
import posixpath
import sys
from pathlib import Path
from typing import Any, BinaryIO, Mapping
from urllib.parse import urlsplit

from . import common, hook
from .redact import clip, cut_utf16, redact, utf16_len

TITLE_MAX = 160
TODOS_MAX = 20
TODO_SUBJECT_MAX = 200
TOOL_NAME_MAX = 128  # LIMITS.toolNameMax (UTF-16 code units)
AGENT_TYPE_MAX = 64
ID_MAX = 128
TODO_ID_MAX = 64
FAILURE_EVENT = 'PostToolUseFailure'  # a failed call fires only this event, never PostToolUse
TOOL_EVENTS = ('PreToolUse', 'PostToolUse', FAILURE_EVENT)
HELPER_EVENTS = {'SubagentStart': 'subagent_start', 'SubagentStop': 'subagent_stop'}
TODO_STATUSES = ('pending', 'in_progress', 'completed')
# Claude Code 2.1.325 has no to-do tools; these classic names keep the summary working if a session has them.
# 'list' replaces the whole list, 'create' and 'update' touch one item.
TODO_TOOLS: dict[str, str] = {'TodoWrite': 'list', 'TaskCreate': 'create', 'TaskUpdate': 'update'}
TASK_ID_KEYS = ('taskId', 'task_id', 'id')
FILE_TOOLS = ('Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'LS')
PATH_KEYS = ('file_path', 'notebook_path', 'path')


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ''


def _field(mapping: Any, key: str) -> str:
    return _str(mapping.get(key)) if isinstance(mapping, Mapping) else ''


def _first_line(text: str) -> str:
    return next((line.strip() for line in text.splitlines() if line.strip()), '')


def rel_path(path: str, cwd: str | None, home: str) -> str:
    """Inside cwd → relative to it ('.' for cwd itself); inside home → '~/…'; otherwise unchanged."""
    for base, prefix in ((cwd, None), (home, '~')):
        if not base:
            continue
        root = base.rstrip('/') or '/'
        if path == root:
            return prefix or '.'
        if path.startswith(root.rstrip('/') + '/'):
            rest = path[len(root.rstrip('/')) + 1:]
            return posixpath.join(prefix, rest) if prefix else rest
    return path


def _url_title(url: str) -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return ''
    return parts.netloc.rpartition('@')[2] + parts.path


def _mcp_title(tool_name: str) -> str:
    server, _, tool = tool_name[len('mcp__'):].partition('__')
    return f'{server}: {tool}' if tool else server


def _todo_title(tool_name: str, tool_input: Any) -> str:
    kind = TODO_TOOLS[tool_name]
    if kind == 'list':
        todos = tool_input.get('todos') if isinstance(tool_input, Mapping) else None
        return f'{len(todos)} items' if isinstance(todos, list) else ''
    if kind == 'create':
        return _field(tool_input, 'subject')
    task_id = _task_id(tool_input) or '?'
    status = _field(tool_input, 'status')
    return f'task {task_id} → {status}' if status else f'task {task_id}'


def _raw_title(tool_name: str, tool_input: Any, cwd: str | None, home: str) -> str:
    if tool_name.startswith('mcp__'):
        return _mcp_title(tool_name)  # from the name only: an MCP tool's input is never read
    if not isinstance(tool_input, Mapping):
        return ''
    if tool_name in TODO_TOOLS:
        return _todo_title(tool_name, tool_input)
    if tool_name in FILE_TOOLS:
        path = next((tool_input[key] for key in PATH_KEYS if isinstance(tool_input.get(key), str)), '')
        return rel_path(path, cwd, home) if path else ''
    if tool_name == 'Bash':
        return _first_line(_field(tool_input, 'command'))
    if tool_name == 'Grep':
        where = _field(tool_input, 'path')
        pattern = _field(tool_input, 'pattern')
        return f'{pattern} in {rel_path(where, cwd, home)}' if where else pattern
    if tool_name == 'Glob':
        return _field(tool_input, 'pattern')
    if tool_name == 'WebFetch':
        return _url_title(_field(tool_input, 'url'))
    if tool_name in ('WebSearch', 'ToolSearch'):
        return _field(tool_input, 'query')
    if tool_name == 'Skill':
        return _field(tool_input, 'skill') or _field(tool_input, 'command')
    if tool_name in ('Agent', 'Task'):
        kind, description = _field(tool_input, 'subagent_type'), _first_line(_field(tool_input, 'description'))
        return f'{kind}: {description}' if kind and description else kind or description
    return ''


def step_title(tool_name: str, tool_input: Any, cwd: str | None, home: str) -> str:
    """The step's one-line title, redacted and clipped to TITLE_MAX."""
    return clip(redact(_raw_title(tool_name, tool_input, cwd, home)), TITLE_MAX)


def _lines(value: Any) -> int:
    text = _str(value)
    if not text:
        return 0
    return text.count('\n') + (0 if text.endswith('\n') else 1)


def line_counts(tool_name: str, tool_input: Any) -> tuple[int | None, int | None]:
    """(added, removed) lines for the edit tools; (None, None) for everything else."""
    if not isinstance(tool_input, Mapping):
        return None, None
    if tool_name == 'Edit':
        return _lines(tool_input.get('new_string')), _lines(tool_input.get('old_string'))
    if tool_name == 'MultiEdit':
        edits = tool_input.get('edits')
        edits = [edit for edit in edits if isinstance(edit, Mapping)] if isinstance(edits, list) else []
        return (sum(_lines(edit.get('new_string')) for edit in edits),
                sum(_lines(edit.get('old_string')) for edit in edits))
    if tool_name == 'Write':
        return _lines(tool_input.get('content')), None
    if tool_name == 'NotebookEdit':
        return _lines(tool_input.get('new_source')), None
    return None, None


def _todo_id(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value)
    return text if 0 < utf16_len(text) <= TODO_ID_MAX else None


def _task_id(*sources: Any) -> str | None:
    for source in sources:
        if not isinstance(source, Mapping):
            continue
        for key in TASK_ID_KEYS:
            found = _todo_id(source.get(key))
            if found is not None:
                return found
        nested = source.get('task')
        if isinstance(nested, Mapping) and _todo_id(nested.get('id')) is not None:
            return _todo_id(nested.get('id'))
    return None


def _subject(value: Any) -> str:
    return clip(redact(_str(value)), TODO_SUBJECT_MAX)


def _todo_list(todos: Any) -> list[dict[str, Any]] | None:
    if not isinstance(todos, list):
        return None
    items = [{'id': _todo_id(item.get('id')), 'subject': _subject(item.get('content')), 'status': item['status']}
             for item in todos if isinstance(item, Mapping) and item.get('status') in TODO_STATUSES]
    return items[:TODOS_MAX]


def todo_items(tool_name: str, tool_input: Any, tool_response: Any) -> tuple[list[dict[str, Any]], str] | None:
    """The to-do list as the call left it: (items, 'replace' | 'merge'), or None when the call has no to-do data."""
    kind = TODO_TOOLS.get(tool_name)
    if kind is None or not isinstance(tool_input, Mapping):
        return None
    if kind == 'list':
        items = _todo_list(tool_input.get('todos'))
        return (items, 'replace') if items is not None else None
    status = tool_input.get('status', 'pending' if kind == 'create' else None)
    if status not in TODO_STATUSES:
        return None
    sources = (tool_response, tool_input) if kind == 'create' else (tool_input, tool_response)
    item = {'id': _task_id(*sources), 'subject': _subject(tool_input.get('subject')), 'status': status}
    return [item], 'merge'


def step_ok(payload: Mapping[str, Any]) -> bool:
    """False for the failure event and for a result that says it was interrupted or failed."""
    if payload.get('hook_event_name') == FAILURE_EVENT:
        return False
    response = payload.get('tool_response')
    if isinstance(response, Mapping):
        return not (response.get('interrupted') is True or response.get('is_error') or response.get('error'))
    return True


def _id(value: Any) -> str | None:
    return value if isinstance(value, str) and 0 < utf16_len(value) <= ID_MAX else None


def _agent_type(value: Any) -> str | None:
    return cut_utf16(value, AGENT_TYPE_MAX)[0] if isinstance(value, str) and value else None


def _helper(name: str, payload: Mapping[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """An internal helper (prompt suggestions) stops with agent_type "" and never starts: it is ignored."""
    agent_id, agent_type = _id(payload.get('agent_id')), payload.get('agent_type')
    if agent_id is None or agent_type == '':
        return None
    return HELPER_EVENTS[name], {'agent_id': agent_id, 'agent_type': _agent_type(agent_type)}


def build_step(payload: Mapping[str, Any], home: str) -> tuple[str, dict[str, Any]] | None:
    """(activity event name, data) for one hook input, or None when the input is not a step."""
    name = payload.get('hook_event_name')
    if name in HELPER_EVENTS:
        return _helper(name, payload)
    tool_name = payload.get('tool_name')
    if name not in TOOL_EVENTS or not isinstance(tool_name, str) or not tool_name or tool_name == 'AskUserQuestion':
        return None
    tool_input = payload.get('tool_input')
    base = {'tool': cut_utf16(tool_name, TOOL_NAME_MAX)[0],
            'title': step_title(tool_name, tool_input, _str(payload.get('cwd')) or None, home),
            'tool_use_id': _id(payload.get('tool_use_id')), 'agent_id': _id(payload.get('agent_id')),
            'agent_type': _agent_type(payload.get('agent_type'))}
    if name == 'PreToolUse':
        return 'tool_start', base
    ok = step_ok(payload)
    added, removed = line_counts(tool_name, tool_input) if ok else (None, None)
    data = {**base, 'ok': ok, 'added': added, 'removed': removed}
    todos = todo_items(tool_name, tool_input, payload.get('tool_response')) if ok else None
    if todos is not None:
        data['todos'], data['todo_mode'] = todos
    return 'tool_end', data


# --- the hook (registered with "async": true on PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart/Stop) ---

def helper_marker(paths: common.KitPaths, session_id: Any, agent_id: str) -> Path:
    """state/helpers/<hash>: exists from a helper's start until its stop."""
    key = f'{session_id if isinstance(session_id, str) else ""}\0{agent_id}'.encode('utf-8', 'replace')
    return paths.helpers / hashlib.sha256(key).hexdigest()[:32]


def _known_helper(paths: common.KitPaths, event: str, payload: Mapping[str, Any], agent_id: str) -> bool:
    """A helper stop is written only after its start was (Claude Code also stops internal helpers)."""
    marker = helper_marker(paths, payload.get('session_id'), agent_id)
    if event == 'subagent_start':
        marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        marker.touch()
        return True
    try:
        marker.unlink()
    except FileNotFoundError:
        return False
    return True


def record_step(raw: bytes, env: hook.HookEnv) -> None:
    payload = json.loads(raw.decode('utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('hook input is not a JSON object')
    built = build_step(payload, str(env.paths.home))
    if built is None:
        return
    event, data = built
    if event in HELPER_EVENTS.values() and not _known_helper(env.paths, event, payload, data['agent_id']):
        return
    target = hook.event_target(env, payload.get('session_id'))
    hook.append(env, common.load_config(env.paths), event, hook.event_meta(payload, target), data)


def main(*, stdin: BinaryIO | None = None, env: hook.HookEnv | None = None) -> int:
    """Step hook entrypoint: always 0, never prints; failures go to state/hook-errors.log."""
    hook_env = env if env is not None else hook.default_env()
    try:
        record_step((stdin if stdin is not None else sys.stdin.buffer).read(hook.STDIN_MAX_BYTES), hook_env)
    except BaseException as exc:  # noqa: BLE001 - a hook must never break the Claude session
        common.log_hook_error(hook_env.paths, f'step hook failed: {type(exc).__name__}: {exc}')
    return 0
