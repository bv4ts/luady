"""Structured permission previews and the "allow always" rule (kit 2).

- `build_preview()` gives the PermissionPreview (`packages/shared/src/spool.ts`): the command, or the file and its
  edits, everything redacted, the whole object cut to fit PREVIEW_MAX_BYTES of JSON.
- `always_rule()` is the `updatedPermissions` entry "Allow always" adds for the rest of the session. It stays in the
  pending file on the server; only its redacted label leaves.
- `allow` says whether the owner may allow the request from afar. A request the preview cannot show whole (a part was
  redacted or cut, for any tool: a command, a file change, an MCP tool's input) is answered in the terminal or
  denied: the hidden part could be what it really does. So is a command whose text hides itself on screen: long runs
  of blank lines or spaces, or invisible format characters (bidirectional overrides, zero-width spaces).
- `one_line()` is the kit-1 `input_preview` that every permission event still carries: Bash's command, or the whole
  input of any other tool.
"""
from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Mapping

from .redact import ELLIPSIS, cut_utf16, redact, redact_values, utf16_len

PREVIEW_MAX_BYTES = 8192
EDITS_MAX = 20
ALWAYS_COMMAND_MAX = 300
ALWAYS_LABEL_MAX = 200
TEXT_MAX = 8192  # LIMITS.permissionPreviewTextMax, UTF-16 code units
PATH_MAX = 1024  # LIMITS.permissionPreviewPathMax
TOOL_NAME_MAX = 128
SIDE_MIN = 200  # below this a side is no longer halved; edits are dropped instead
LAST_RESORT_MIN = 16
EDIT_TOOLS = ('Edit', 'MultiEdit', 'NotebookEdit')
ONE_LINE_MAX = 2000  # the kit-1 input_preview, in characters (LIMITS.permissionInputPreview)
ONE_LINE_COMMAND_KEYS = frozenset({'command', 'description'})  # a non-Bash input shown as its bare command
_NOT_PLAIN = re.compile(r'[*?\[;|&<>`\n\r]|\$[({]')
# Text that pushes the rest of a command out of the preview box: three blank lines in a row, or 200 whitespace
# characters in a row.
_PADDING = re.compile(r'\s{200,}|(?:\A|\n)(?:[^\S\n]*\n){3}')


def hides_itself(text: str) -> bool:
    """True when text can keep part of itself off the screen while nothing was cut: padding, or a format character
    (Unicode category Cf: bidirectional overrides, zero-width spaces and joiners, the byte-order mark)."""
    return _PADDING.search(text) is not None or any(unicodedata.category(char) == 'Cf' for char in text)


def _bare_command(tool_name: str, tool_input: Any) -> bool:
    """Whether the one-line text is the input's `command` alone: always for Bash, whose input is its command; for any
    other tool only when nothing but a `description` sits beside it (its args, env or host would not be shown)."""
    if not isinstance(tool_input, Mapping) or not isinstance(tool_input.get('command'), str):
        return False
    return tool_name == 'Bash' or set(tool_input) <= ONE_LINE_COMMAND_KEYS


def one_line(tool_name: str, tool_input: Any) -> tuple[str, bool, bool]:
    """The kit-1 `input_preview`: Bash's `command` (or the `command` of an input with nothing else but a
    `description`), else the whole input as JSON. Every string value is redacted before it is encoded (redacting the
    encoded JSON missed quoted values, which JSON escapes), then the text is cut to ONE_LINE_MAX characters. Returns
    (text, cut, redacted)."""
    if _bare_command(tool_name, tool_input):
        raw = tool_input['command']
        text = redact(raw)
        hidden = text != raw
    else:
        clean = redact_values(tool_input)
        hidden = clean != tool_input
        text = json.dumps(clean, ensure_ascii=False, sort_keys=True, default=str)
    if len(text) <= ONE_LINE_MAX:
        return text, False, hidden
    return text[:ONE_LINE_MAX - 1] + ELLIPSIS, True, hidden


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ''


def _plain_rule_content(content: Any) -> bool:
    """Rule content that allows exactly one command. `*`, `?`, `[` (and a `:*` suffix) are wildcards in
    Claude Code rules; separators, redirections, substitutions and line breaks would hide a second command; and a
    command the kit had to redact cannot be shown to the owner as it is."""
    if not isinstance(content, str) or not content.strip() or len(content) > ALWAYS_COMMAND_MAX:
        return False
    return _NOT_PLAIN.search(content) is None and redact(content) == content


def _clean_rules(rules: Any) -> list[dict[str, str]] | None:
    if not isinstance(rules, list) or not rules:
        return None
    clean = []
    for rule in rules:
        if not isinstance(rule, Mapping) or not _str(rule.get('toolName')):
            return None
        content = rule.get('ruleContent')
        if content is not None and not _plain_rule_content(content):
            return None
        clean.append({'toolName': rule['toolName'], **({'ruleContent': content} if content is not None else {})})
    return clean


def _session_rule(rules: list[dict[str, str]]) -> dict[str, Any]:
    return {'type': 'addRules', 'rules': rules, 'behavior': 'allow', 'destination': 'session'}


def always_rule(tool_name: str, tool_input: Any, suggestions: Any) -> dict[str, Any] | None:
    """An `addRules`/`allow` suggestion scoped to the session, else the exact one-line Bash command (at most
    ALWAYS_COMMAND_MAX characters, otherwise not offered) or the tool name for any other tool."""
    for suggestion in suggestions if isinstance(suggestions, list) else []:
        suggestion = _mapping(suggestion)
        rules = _clean_rules(suggestion.get('rules'))
        if suggestion.get('type') == 'addRules' and suggestion.get('behavior') == 'allow' and rules:
            return _session_rule(rules)
    if not isinstance(tool_name, str) or not tool_name:
        return None
    if tool_name != 'Bash':
        return _session_rule([{'toolName': tool_name}])
    command = _str(_mapping(tool_input).get('command'))
    return _session_rule([{'toolName': 'Bash', 'ruleContent': command}]) if _plain_rule_content(command) else None


def always_label(rule: Mapping[str, Any] | None) -> str | None:
    """What "Allow always" allows, as the owner sees it: `Bash(<rule content>)` or the tool name, redacted."""
    if not isinstance(rule, Mapping):
        return None
    parts = [f'{r["toolName"]}({r["ruleContent"]})' if r.get('ruleContent') else r['toolName']
             for r in _clean_rules(rule.get('rules')) or []]
    return cut_utf16(redact(', '.join(parts)), ALWAYS_LABEL_MAX)[0] if parts else None


def _text(value: Any, limit: int = TEXT_MAX) -> tuple[str, bool]:
    return cut_utf16(redact(_str(value)), limit)


def _edit_pairs(tool_name: str, tool_input: Mapping[str, Any]) -> list[tuple[Any, Any]]:
    if tool_name == 'Edit':
        return [(tool_input.get('old_string'), tool_input.get('new_string'))]
    if tool_name == 'MultiEdit':
        raw = tool_input.get('edits') if isinstance(tool_input.get('edits'), list) else []
        return [(edit.get('old_string'), edit.get('new_string')) for edit in raw if isinstance(edit, Mapping)]
    return [('', tool_input.get('new_source' if tool_name == 'NotebookEdit' else 'content'))]  # NotebookEdit, Write


def _shown(value: Any, limit: int = TEXT_MAX) -> tuple[str, bool, bool]:
    """(the text as shown: redacted, then cut to `limit` UTF-16 units; was it cut; did the redactor change it)."""
    raw = _str(value)
    clean = redact(raw)
    text, cut = cut_utf16(clean, limit)
    return text, cut, clean != raw


def _edits(tool_name: str, tool_input: Mapping[str, Any]) -> tuple[list[dict[str, str]], bool, bool]:
    """(the edits shown, was anything cut or dropped, was anything redacted)."""
    pairs = _edit_pairs(tool_name, tool_input)
    cut, hidden = len(pairs) > EDITS_MAX, False
    edits = []
    for old, new in pairs[:EDITS_MAX]:
        (old_text, old_cut, old_hidden), (new_text, new_cut, new_hidden) = _shown(old), _shown(new)
        cut, hidden = cut or old_cut or new_cut, hidden or old_hidden or new_hidden
        edits.append({'old': old_text, 'new': new_text})
    return edits, cut, hidden


def _size(preview: Mapping[str, Any]) -> int:
    return len(json.dumps(preview, ensure_ascii=False).encode('utf-8', 'replace'))


def _halve(text: str) -> str:
    return cut_utf16(text, max(1, utf16_len(text) // 2))[0]


def _shrink(preview: dict[str, Any]) -> dict[str, Any] | None:
    """One step towards PREVIEW_MAX_BYTES: halve the longest text side; once all are short, drop the last edit."""
    sides = [(len(preview['command']), -1, '')] if preview['command'] is not None else []
    sides += [(len(edit[side]), index, side) for index, edit in enumerate(preview['edits']) for side in ('old', 'new')]
    length, index, side = max(sides) if sides else (0, -1, '')
    if length >= SIDE_MIN:
        if index < 0:
            return {**preview, 'command': _halve(preview['command'])}
        edits = [{**edit, side: _halve(edit[side])} if i == index else edit for i, edit in enumerate(preview['edits'])]
        return {**preview, 'edits': edits}
    if preview['edits']:
        return {**preview, 'edits': preview['edits'][:-1]}
    for key in ('path', 'cwd', 'command'):  # escapes in a short path can still be too much
        value = preview[key]
        if value is not None and utf16_len(value) > LAST_RESORT_MIN:
            return {**preview, key: _halve(value)}
    return None


def _fit(preview: dict[str, Any]) -> dict[str, Any]:
    cut = preview['truncated']
    while _size(preview) > PREVIEW_MAX_BYTES:
        smaller = _shrink(preview)
        if smaller is None:
            break
        preview, cut = smaller, True
    return {**preview, 'truncated': cut}


def build_preview(tool_name: str, tool_input: Any, cwd: str | None, rule: Mapping[str, Any] | None) -> dict[str, Any]:
    """The PermissionPreview of one permission request; every string redacted, at most PREVIEW_MAX_BYTES."""
    data = _mapping(tool_input)
    name = _str(tool_name)
    kind, command, path, edits = 'other', None, None, []
    if name == 'Bash':
        raw = _str(data.get('command'))
        kind, (command, cut, hidden) = 'command', _shown(raw)
        hidden = hidden or (not cut and hides_itself(raw))
    elif name in EDIT_TOOLS or name == 'Write':
        kind = 'write' if name == 'Write' else 'edit'
        path_key = 'notebook_path' if name == 'NotebookEdit' else 'file_path'
        (path, path_cut, path_hidden), (edits, cut, hidden) = _shown(data.get(path_key), PATH_MAX), _edits(name, data)
        cut, hidden = cut or path_cut, hidden or path_hidden
    else:  # an MCP tool or any other: the owner reads the one-line preview, which may hold a command too
        text, cut, hidden = one_line(name, tool_input)
        hidden = hidden or (not cut and hides_itself(text))
    cwd_text, cwd_cut = _text(cwd, PATH_MAX) if isinstance(cwd, str) else (None, False)
    label = always_label(rule)
    preview = {'tool': cut_utf16(name or 'unknown', TOOL_NAME_MAX)[0], 'kind': kind, 'command': command,
               'path': path, 'cwd': cwd_text, 'edits': edits, 'truncated': cut or cwd_cut,
               'always': {'label': label} if label is not None else None}
    fitted = _fit(preview)
    if fitted['truncated'] or hidden:  # Deny or the terminal only
        return {**fitted, 'always': None, 'allow': False}
    return {**fitted, 'allow': True}
