#!/usr/bin/python3
"""fake-claude: stand-in for the Claude Code CLI inside the Luady integration image.

It is started in a tmux pane exactly like the real CLI (see /home/dev/.local/bin/claude). It:
- fires the hooks registered in ~/.claude/settings.json (and in a `--settings` file) with realistic hook JSON;
- reads keystrokes from its TTY with bracketed-paste support;
- shows a folder-trust dialog for untrusted folders (trusted: its own list, or ~/.claude.json's hasTrustDialogAccepted);
- appends one JSON line per observable action to ~/.fake-claude/log.jsonl.

Input (typed or pasted, submitted with Enter):
  /ask   one single-select AskUserQuestion; blocks until the PreToolUse hook returns
  /ask2  two questions: single-select + multi-select
  /tool <Name> <json>  one tool call: PreToolUse, PostToolUse (tool_response {}), then Stop
  /steps <n>           n Bash calls (echo step-<i>), 0.3 s apart, each held open STEP_HOLD_SECONDS (observable as running)
  /agent               SubagentStart (Explore), one inner Grep call carrying agent_id/agent_type, SubagentStop
  /perm <Name> <json>  PermissionRequest for that tool; logs `permission` with the hook's decision
  /exit  SessionEnd(prompt_input_exit), then exit 0
  other  UserPromptSubmit, then Stop with "Echo (<n> chars): <text>"
A synchronous PostToolUse hook that prints {"continue": false, ...} ends the turn at once: `stopped` is logged,
"STOPPED <reason>" printed, the remaining calls skipped and no Stop fired.
At start and at every turn end a `statusLine` command from settings runs with a status JSON (rate_limits unless
~/.fake-claude/no-limits exists; percentages from ~/.fake-claude/status.json) and its stdout is logged as `statusline`.
`claude auth status` / `claude auth logout` read and write ~/.fake-claude/auth.json (default: signed in, Team plan).
Escape and Ctrl-C are logged and ignored. FAKE_CLAUDE_NO_HOOKS=1 disables every hook.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import select
import subprocess
import sys
import termios
import time
import uuid

VERSION = '2.1.295 (Claude Code)'
HOME = os.path.expanduser('~')
STATE_DIR = os.path.join(HOME, '.fake-claude')
LOG_PATH = os.path.join(STATE_DIR, 'log.jsonl')
TRUST_PATH = os.path.join(STATE_DIR, 'trusted.json')
SETTINGS_PATH = os.path.join(HOME, '.claude', 'settings.json')
CLAUDE_JSON = os.path.join(HOME, '.claude.json')
# `--settings <file>`: read after the user's settings, both hook lists apply (as Claude Code merges its sources).
EXTRA_SETTINGS: list = []
STATUS_PATH = os.path.join(STATE_DIR, 'status.json')
NO_LIMITS_PATH = os.path.join(STATE_DIR, 'no-limits')
AUTH_PATH = os.path.join(STATE_DIR, 'auth.json')
SIGNED_IN = {'loggedIn': True, 'authMethod': 'claude.ai', 'orgId': 'org_fake', 'orgName': 'Fake Team',
             'subscriptionType': 'team', 'planTier': None, 'loginExpiresAt': None}
SIGNED_OUT = {'loggedIn': False, 'authMethod': 'none'}
STEPS_MAX = 50
STEP_HOLD_SECONDS = 0.5  # how long each /steps call stays open between its two hooks, so the office can show it running
PASTE_START = b'\x1b[200~'
PASTE_END = b'\x1b[201~'
SHIFT_ENTER = b'\x1b[13;2u'  # what tmux sends for S-Enter once the app enabled modifyOtherKeys
EXACT_MATCHER = re.compile(r'^[A-Za-z0-9_\- ,|]+$')
QUESTION_COLOR = {
    'question': 'Which color should the button be?', 'header': 'Color', 'multiSelect': False,
    'options': [{'label': 'Blue', 'description': 'Calm and familiar'},
                {'label': 'Green', 'description': 'Fresh and friendly'}],
}
QUESTION_EXTRAS = {
    'question': 'Which extras do you want?', 'header': 'Extras', 'multiSelect': True,
    'options': [{'label': 'Tests', 'description': 'Add unit tests'},
                {'label': 'Docs', 'description': 'Update the README'},
                {'label': 'Lint', 'description': 'Run the linter'}],
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def out(text: str) -> None:
    sys.stdout.buffer.write(text.encode('utf-8'))
    sys.stdout.buffer.flush()


def tmux_target() -> str | None:
    pane = os.environ.get('TMUX_PANE')
    if not pane:
        return None
    r = subprocess.run(['tmux', 'display', '-p', '-t', pane, '#S:#I.#P'], capture_output=True, text=True, check=False)
    return r.stdout.strip() or None


class Session:
    def __init__(self, args: argparse.Namespace) -> None:
        self.cwd = os.getcwd()
        self.sid = args.resume or str(uuid.uuid4())
        self.source = 'resume' if args.resume else 'startup'
        self.mode = args.permission_mode or 'default'
        self.model = args.model or 'opus'
        self.hooks_enabled = os.environ.get('FAKE_CLAUDE_NO_HOOKS') != '1'
        self.target = tmux_target()
        encoded = re.sub(r'[^A-Za-z0-9]', '-', self.cwd)
        self.transcript = os.path.join(HOME, '.claude', 'projects', encoded, f'{self.sid}.jsonl')
        self.last_uuid: str | None = None
        self.children: list[subprocess.Popen] = []
        hour = int(time.time()) // 3600 * 3600
        self.resets = {'five_hour': hour + 5 * 3600, 'seven_day': hour + 7 * 86400}

    def log(self, kind: str, **data: object) -> None:
        os.makedirs(STATE_DIR, exist_ok=True)
        entry = {'ts': now_iso(), 'sid': self.sid, 'target': self.target, 'cwd': self.cwd, 'kind': kind, **data}
        fd = os.open(LOG_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, (json.dumps(entry, ensure_ascii=False) + '\n').encode('utf-8'))
        finally:
            os.close(fd)

    def record(self, role: str, text: str) -> None:
        os.makedirs(os.path.dirname(self.transcript), exist_ok=True)
        entry_uuid = str(uuid.uuid4())
        content = text if role == 'user' else [{'type': 'text', 'text': text}]
        entry = {'type': role, 'uuid': entry_uuid, 'parentUuid': self.last_uuid, 'sessionId': self.sid,
                 'timestamp': now_iso(), 'cwd': self.cwd, 'message': {'role': role, 'content': content}}
        with open(self.transcript, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
        self.last_uuid = entry_uuid

    def base(self, event: str) -> dict:
        return {'session_id': self.sid, 'transcript_path': self.transcript, 'cwd': self.cwd,
                'permission_mode': self.mode, 'hook_event_name': event}


def matcher_matches(matcher: str | None, subject: str | None) -> bool:
    if matcher in (None, '', '*'):
        return True
    if subject is None:
        return False
    if EXACT_MATCHER.match(matcher):
        return subject in [part.strip() for part in matcher.split('|')]
    return re.search(matcher, subject) is not None


def load_hook_groups(event: str) -> list:
    groups: list = []
    for path in [SETTINGS_PATH, *EXTRA_SETTINGS]:
        try:
            with open(path, encoding='utf-8') as fh:
                found = json.load(fh).get('hooks', {}).get(event, [])
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(found, list):
            groups.extend(found)
    return groups


def spawn_async(session: Session, command: str, data: bytes, env: dict) -> None:
    proc = subprocess.Popen(['sh', '-c', command], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    try:
        proc.stdin.write(data)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    session.children = [p for p in session.children if p.poll() is None] + [proc]


def run_hooks(session: Session, event: str, payload: dict, subject: str | None = None,
              force_sync: bool = False) -> list:
    """Runs matching command hooks like Claude Code: sh -c, JSON on stdin, identical commands once."""
    if not session.hooks_enabled:
        return []
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    env = {**os.environ, 'CLAUDE_PROJECT_DIR': session.cwd}
    seen: set[str] = set()
    results = []
    for group in load_hook_groups(event):
        if not matcher_matches(group.get('matcher'), subject):
            continue
        for hook in group.get('hooks', []):
            command = hook.get('command')
            if hook.get('type') != 'command' or not command or command in seen:
                continue
            seen.add(command)
            if hook.get('async') and not force_sync:
                spawn_async(session, command, data, env)
                continue
            try:
                results.append(subprocess.run(['sh', '-c', command], input=data, capture_output=True, env=env,
                                              timeout=hook.get('timeout') or 600, check=False))
            except subprocess.TimeoutExpired:
                session.log('hook_timeout', event=event, command=command)
    return results


def user_turn(session: Session, text: str) -> bool:
    session.record('user', text)
    payload = {**session.base('UserPromptSubmit'), 'prompt': text}
    blocked = [r for r in run_hooks(session, 'UserPromptSubmit', payload) if r.returncode == 2]
    if blocked:
        session.log('blocked', event='UserPromptSubmit', stderr=blocked[0].stderr.decode('utf-8', 'replace'))
        out('UserPromptSubmit hook blocked the prompt\n> ')
        return False
    return True


def finish_turn(session: Session, reply: str) -> None:
    session.record('assistant', reply)
    run_hooks(session, 'Stop', {**session.base('Stop'), 'stop_hook_active': False, 'last_assistant_message': reply})
    out(f'{reply}\n> ')
    status_line(session)


def read_json(path: str, default: object) -> object:
    try:
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def status_payload(session: Session) -> dict:
    """The status-line JSON of Claude Code 2.1.325, trimmed to what the kit reads plus the common keys."""
    pct = read_json(STATUS_PATH, {})
    pct = pct if isinstance(pct, dict) else {}
    payload = {'session_id': session.sid, 'transcript_path': session.transcript, 'cwd': session.cwd,
               'model': {'id': f'claude-{session.model}', 'display_name': session.model.capitalize()},
               'workspace': {'current_dir': session.cwd, 'project_dir': session.cwd, 'added_dirs': []},
               'version': VERSION.split()[0], 'cost': {'total_cost_usd': 0.0125, 'total_duration_ms': 1000},
               'context_window': {'used_percentage': pct.get('context', 12), 'context_window_size': 200000}}
    if not os.path.exists(NO_LIMITS_PATH):
        payload['rate_limits'] = {
            name: {'used_percentage': pct.get(name, default), 'resets_at': session.resets[name]}
            for name, default in (('five_hour', 20), ('seven_day', 35))}
    return payload


def status_line(session: Session) -> None:
    """Runs the settings' statusLine command like Claude Code (sh -c, JSON on stdin) and logs what it printed."""
    settings = read_json(SETTINGS_PATH, {})
    line = settings.get('statusLine') if isinstance(settings, dict) else None
    if not session.hooks_enabled or not isinstance(line, dict) or line.get('type') != 'command':
        return
    command = line.get('command')
    if not isinstance(command, str) or not command:
        return
    data = json.dumps(status_payload(session), ensure_ascii=False).encode('utf-8')
    try:
        result = subprocess.run(['sh', '-c', command], input=data, capture_output=True, timeout=5, check=False,
                                env={**os.environ, 'CLAUDE_PROJECT_DIR': session.cwd})
    except subprocess.TimeoutExpired:
        session.log('statusline_timeout')
        return
    session.log('statusline', text=result.stdout.decode('utf-8', 'replace'))


class Stopped(Exception):
    """A synchronous PostToolUse hook answered {"continue": false}."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def stop_reason(results: list) -> str | None:
    for result in results:
        try:
            output = json.loads(result.stdout.decode('utf-8'))
        except ValueError:
            continue
        if isinstance(output, dict) and output.get('continue') is False:
            reason = output.get('stopReason')
            return reason if isinstance(reason, str) else ''
    return None


def tool_call(session: Session, name: str, tool_input: object, agent: dict | None = None, hold: float = 0.0) -> None:
    """PreToolUse and PostToolUse for one call (agent ids inside a helper); raises Stopped on a stop answer.
    `hold` keeps the step open between the two hooks so a slow tool is observable as running (used by /steps)."""
    tool_use_id = f'toolu_{uuid.uuid4().hex[:24]}'
    extra = dict(agent or {})
    pre = {**session.base('PreToolUse'), **extra, 'tool_name': name, 'tool_input': tool_input,
           'tool_use_id': tool_use_id}
    run_hooks(session, 'PreToolUse', pre, subject=name)
    if hold:
        time.sleep(hold)
    post = {**pre, 'hook_event_name': 'PostToolUse', 'tool_response': {}, 'duration_ms': 1}
    results = run_hooks(session, 'PostToolUse', post, subject=name)
    session.log('tool', name=name, tool_use_id=tool_use_id, agent_id=extra.get('agent_id'))
    reason = stop_reason(results)
    if reason is not None:
        raise Stopped(reason)


def tool_turn(session: Session, text: str, body) -> None:
    """One turn whose body makes tool calls and returns the reply; a pause stop ends it without a Stop event."""
    if not user_turn(session, text):
        return
    try:
        reply = body()
    except Stopped as stop:
        session.log('stopped', reason=stop.reason)
        out(f'STOPPED {stop.reason}\n> ')
        return
    finish_turn(session, reply)


def run_tool(session: Session, name: str, tool_input: object) -> str:
    tool_call(session, name, tool_input)
    return f'Used {name}.'


def run_steps(session: Session, count: int) -> str:
    for index in range(1, count + 1):
        time.sleep(0.3)
        tool_call(session, 'Bash', {'command': f'echo step-{index}', 'description': f'step {index}'}, hold=STEP_HOLD_SECONDS)
    return f'Ran {count} steps.'


def run_agent(session: Session) -> str:
    agent = {'agent_id': f'agent-{uuid.uuid4().hex[:12]}', 'agent_type': 'Explore'}
    run_hooks(session, 'SubagentStart', {**session.base('SubagentStart'), **agent}, subject='Explore')
    time.sleep(0.5)  # a real helper first waits for the model for a second or more
    tool_call(session, 'Grep', {'pattern': 'TODO', 'path': session.cwd}, agent)
    time.sleep(0.3)
    stop = {**session.base('SubagentStop'), **agent, 'stop_hook_active': False,
            'agent_transcript_path': session.transcript, 'last_assistant_message': 'Found 0 matches.'}
    run_hooks(session, 'SubagentStop', stop, subject='Explore')
    return 'The helper found nothing.'


def parse_decision(results: list) -> dict | None:
    for result in results:
        try:
            output = json.loads(result.stdout.decode('utf-8'))
        except ValueError:
            continue
        decision = (output.get('hookSpecificOutput') or {}).get('decision') if isinstance(output, dict) else None
        if isinstance(decision, dict):
            return decision
    return None


def perm_turn(session: Session, text: str, name: str, tool_input: object) -> None:
    if not user_turn(session, text):
        return
    suggestions = [{'type': 'addDirectories', 'directories': [session.cwd], 'destination': 'session'},
                   {'type': 'setMode', 'mode': 'acceptEdits', 'destination': 'session'}]
    payload = {**session.base('PermissionRequest'), 'tool_name': name, 'tool_input': tool_input,
               'permission_suggestions': suggestions}
    decision = parse_decision(run_hooks(session, 'PermissionRequest', payload, subject=name)) or {}
    updated = decision.get('updatedPermissions')
    session.log('permission', tool=name, behavior=decision.get('behavior'), updated=bool(updated),
                updated_permissions=updated)
    finish_turn(session, f'Permission for {name}: {decision.get("behavior") or "asked in the terminal"}')


def tool_args(command: str) -> tuple[str, object] | None:
    """`/tool Bash {"command": "ls"}` -> ('Bash', {...}); None when the name or the JSON is missing."""
    parts = command.split(None, 2)
    if len(parts) < 2:
        return None
    try:
        return parts[1], json.loads(parts[2]) if len(parts) == 3 else {}
    except ValueError:
        return None


def parse_answers(results: list) -> dict | None:
    for result in results:
        if result.returncode != 0 or not result.stdout.strip():
            continue
        try:
            output = json.loads(result.stdout.decode('utf-8'))
        except ValueError:
            continue
        specific = output.get('hookSpecificOutput') or {}
        answers = (specific.get('updatedInput') or {}).get('answers')
        if specific.get('permissionDecision') == 'allow' and isinstance(answers, dict):
            return answers
    return None


def echo_turn(session: Session, text: str) -> None:
    if not user_turn(session, text):
        return
    time.sleep(0.6)  # a real turn takes time; keeps the async prompt hook ahead of the Stop hook
    session.log('received', text=text)
    out('RECEIVED ' + json.dumps(text, ensure_ascii=False) + '\n')
    finish_turn(session, f'Echo ({len(text)} chars): {text}')


def ask_turn(session: Session, text: str, questions: list) -> None:
    if not user_turn(session, text):
        return
    payload = {**session.base('PreToolUse'), 'tool_name': 'AskUserQuestion', 'tool_input': {'questions': questions},
               'tool_use_id': f'toolu_{uuid.uuid4().hex[:24]}'}
    results = run_hooks(session, 'PreToolUse', payload, subject='AskUserQuestion')
    answers = parse_answers(results)
    if answers is not None:
        session.log('answers', answers=answers)
        out('ANSWERS ' + json.dumps(answers, ensure_ascii=False) + '\n')
        finish_turn(session, 'Thanks, noted: ' + json.dumps(answers, ensure_ascii=False))
    elif any(r.returncode == 2 for r in results):
        session.log('blocked', event='PreToolUse', stderr='')
        finish_turn(session, 'The question was blocked by a hook.')
    else:
        session.log('dialog', questions=[q['question'] for q in questions])
        out('(no remote answer: the terminal dialog would be shown now)\n')
        finish_turn(session, 'Asked in the terminal dialog.')


def handle(session: Session, text: str) -> None:
    command = text.strip()
    word = command.split(None, 1)[0] if command else ''
    parsed = tool_args(command) if word in ('/tool', '/perm') else None
    if command == '/ask':
        ask_turn(session, text, [QUESTION_COLOR])
    elif command == '/ask2':
        ask_turn(session, text, [QUESTION_COLOR, QUESTION_EXTRAS])
    elif word == '/tool' and parsed:
        tool_turn(session, text, lambda: run_tool(session, *parsed))
    elif word == '/perm' and parsed:
        perm_turn(session, text, *parsed)
    elif word == '/steps' and command[len('/steps'):].strip().isdigit():
        count = min(int(command[len('/steps'):].strip()), STEPS_MAX)
        tool_turn(session, text, lambda: run_steps(session, count))
    elif command == '/agent':
        tool_turn(session, text, lambda: run_agent(session))
    else:
        echo_turn(session, text)


def start_session(session: Session) -> None:
    os.makedirs(os.path.dirname(session.transcript), exist_ok=True)
    open(session.transcript, 'a', encoding='utf-8').close()
    payload = {**session.base('SessionStart'), 'source': session.source, 'model': session.model}
    run_hooks(session, 'SessionStart', payload, subject=session.source)
    session.log('start', source=session.source, argv=sys.argv[1:])
    out(f'fake-claude {VERSION} · session {session.sid}\n> ')
    status_line(session)


def end_session(session: Session, reason: str) -> None:
    run_hooks(session, 'SessionEnd', {**session.base('SessionEnd'), 'reason': reason}, force_sync=True)
    session.log('exit', reason=reason)


def load_trusted() -> list:
    try:
        with open(TRUST_PATH, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return [d for d in data if isinstance(d, str)] if isinstance(data, list) else []


def save_trusted(paths: list) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = f'{TRUST_PATH}.{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(paths, fh)
    os.replace(tmp, TRUST_PATH)


class KeyReader:
    """Turns raw TTY bytes into ('submit', text) and ('key', name) events, bracketed-paste aware."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.pending = b''
        self.buf = bytearray()
        self.in_paste = False

    def _read_more(self, timeout: float | None) -> bool:
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if not ready:
            return False
        chunk = os.read(self.fd, 65536)
        if not chunk:
            raise EOFError
        self.pending += chunk
        return True

    def next_event(self) -> tuple:
        while True:
            if not self.pending:
                self._read_more(None)
                continue
            event = self._step()
            if event is not None:
                return event

    def _escape(self) -> tuple | None:
        p = self.pending
        for arrow, name in ((b'\x1b[B', 'Down'), (b'\x1bOB', 'Down'), (b'\x1b[A', 'Up'), (b'\x1bOA', 'Up')):
            if p.startswith(arrow):
                self.pending = p[len(arrow):]
                return ('key', name)
        if p.startswith(SHIFT_ENTER):
            self.buf += b'\n'
            self.pending = p[len(SHIFT_ENTER):]
            return None
        for marker, state in ((PASTE_START, True), (PASTE_END, False)):
            if p.startswith(marker):
                self.in_paste, self.pending = state, p[len(marker):]
                return None
        partial = len(p) < len(PASTE_START) and (PASTE_START.startswith(p) or PASTE_END.startswith(p) or SHIFT_ENTER.startswith(p) or any(a.startswith(p) for a in (b'\x1b[B', b'\x1bOB', b'\x1b[A', b'\x1bOA')))
        if partial and self._read_more(0.05):
            return None
        self.pending = p[1:]
        if self.in_paste:
            self.buf += b'\x1b'
            return None
        return ('key', 'Escape')

    def _step(self) -> tuple | None:
        if self.pending.startswith(b'\x1b'):
            return self._escape()
        byte, self.pending = self.pending[:1], self.pending[1:]
        if self.in_paste:
            self.buf += b'\n' if byte == b'\r' else byte
            return None
        if byte in (b'\r', b'\n'):
            text, self.buf = self.buf.decode('utf-8', errors='replace'), bytearray()
            return ('submit', text)
        if byte == b'\x03':
            return ('key', 'C-c')
        if byte == b'\x7f':
            self.buf = bytearray(self.buf.decode('utf-8', errors='ignore')[:-1].encode('utf-8'))
            return None
        self.buf += byte
        return None


def draw_trust(cwd: str, selected: int) -> None:
    """Claude Code 2.1.296 preselects "No, exit"; the cursor is marked with the pointer glyph."""
    rows = ['Yes, proceed', 'No, exit']
    body = '\n'.join(('❯ ' if index == selected else '  ') + f'{index + 1}. {label}' for index, label in enumerate(rows))
    out('\x1b[2J\x1b[H')  # redraw in place, like the real dialog
    out(f'Do you trust the files in this folder?\n\n  {cwd}\n\n{body}\n\nEnter to confirm · Esc to exit\n')


def trust_preaccepted(cwd: str) -> bool:
    """The real CLI's own record: ~/.claude.json projects[<cwd>].hasTrustDialogAccepted."""
    data = read_json(CLAUDE_JSON, {})
    projects = data.get('projects') if isinstance(data, dict) else None
    entry = projects.get(cwd) if isinstance(projects, dict) else None
    return isinstance(entry, dict) and entry.get('hasTrustDialogAccepted') is True


def trust_folder(session: Session, reader: KeyReader) -> bool:
    trusted = load_trusted()
    if session.cwd in trusted or trust_preaccepted(session.cwd):
        return True
    selected = 1
    draw_trust(session.cwd, selected)
    while True:
        try:
            kind, value = reader.next_event()
        except EOFError:
            return False
        if kind == 'key' and value in ('Down', 'Up'):
            selected = 1 - selected
            draw_trust(session.cwd, selected)
        elif kind == 'key' and value == 'Escape':
            session.log('trust_declined')
            return False
        elif kind == 'submit':
            if selected == 1:
                session.log('trust_declined')
                return False
            save_trusted(trusted + [session.cwd])
            session.log('trust')
            return True


def run_tty(session: Session, reader: KeyReader, prompt: str | None) -> int:
    out('\x1b[>4;2m')  # like Claude Code: ask the terminal for modifyOtherKeys so tmux encodes S-Enter
    if not trust_folder(session, reader):
        return 1
    start_session(session)
    if prompt:
        handle(session, prompt)
    while True:
        try:
            kind, value = reader.next_event()
        except EOFError:
            return 0
        if kind == 'key':
            session.log('key', key=value)
        elif value.strip() == '/exit':
            end_session(session, 'prompt_input_exit')
            out('bye\n')
            return 0
        elif value.strip():
            handle(session, value)


def run_lines(session: Session, prompt: str | None) -> int:
    start_session(session)
    if prompt:
        handle(session, prompt)
    for raw in sys.stdin.buffer:
        text = raw.decode('utf-8', 'replace').rstrip('\n')
        if text.strip() == '/exit':
            break
        if text.strip():
            handle(session, text)
    end_session(session, 'prompt_input_exit')
    return 0


def raw_tty(fd: int) -> list:
    old = termios.tcgetattr(fd)
    new = termios.tcgetattr(fd)
    new[0] &= ~(termios.ICRNL | termios.INLCR | termios.IGNCR | termios.IXON)
    new[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG | termios.IEXTEN)
    new[6][termios.VMIN] = 1
    new[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, new)
    return old


def parse_args(argv: list) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog='claude', add_help=False)
    parser.add_argument('--version', '-v', action='store_true')
    parser.add_argument('--permission-mode')
    parser.add_argument('--model')
    parser.add_argument('--resume', '-r')
    parser.add_argument('--settings')
    # The manager's launch flags (hub luady/launch.ts): accepted, so their values never become the first prompt.
    parser.add_argument('--restricted', action='store_true')
    parser.add_argument('--setting-sources')
    parser.add_argument('--mcp-config')
    parser.add_argument('--strict-mcp-config', action='store_true')
    parser.add_argument('--disallowedTools')
    parser.add_argument('--effort')
    parser.add_argument('--remote-control')  # the kit's `start` passes it; accepted, so its value never becomes part of the prompt
    parser.add_argument('--continue', '-c', dest='cont', action='store_true')
    parser.add_argument('words', nargs='*')
    return parser.parse_known_args(argv)[0]


def auth_command(words: list) -> int:
    """`claude auth status` (JSON, exit 1 when signed out) and `claude auth logout`."""
    if words[1:2] == ['logout']:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(AUTH_PATH, 'w', encoding='utf-8') as fh:
            json.dump(SIGNED_OUT, fh)
        out('Successfully logged out from your Anthropic account.\n')
        return 0
    status = read_json(AUTH_PATH, SIGNED_IN)
    status = status if isinstance(status, dict) else SIGNED_IN
    out(json.dumps(status, indent=2) + '\n')
    return 0 if status.get('loggedIn') is True else 1


def main(argv: list) -> int:
    args = parse_args(argv)
    if args.version:
        out(VERSION + '\n')
        return 0
    if args.words[:1] == ['update']:
        out(f'Claude Code is up to date ({VERSION.split()[0]})\n')
        return 0
    if args.words[:1] == ['auth'] and args.words[1:2] in (['status'], ['logout']):
        return auth_command(args.words)
    if args.settings:
        EXTRA_SETTINGS.append(args.settings)
    session = Session(args)
    prompt = ' '.join(args.words) if args.words else None
    fd = sys.stdin.fileno()
    if not os.isatty(fd):
        return run_lines(session, prompt)
    old = raw_tty(fd)
    out('\x1b[?2004h')
    try:
        return run_tty(session, KeyReader(fd), prompt)
    finally:
        out('\x1b[?2004l')
        termios.tcsetattr(fd, termios.TCSANOW, old)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
