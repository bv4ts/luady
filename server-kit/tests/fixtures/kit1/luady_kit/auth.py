"""auth-status, auth-login and auth-code verbs: sign Claude Code in from the chat (/login).

- auth-login runs `claude auth login --claudeai` in its own tmux server (socket `luady-auth`), so it can never be
  mistaken for a worker session or for the manager's `manager` session, and returns the sign-in link.
- auth-code types the code the owner pasted (stdin only) into that login and reports the result.
- The login gives up after LOGIN_TIMEOUT_SECONDS; its pane stays KEEP_SECONDS longer so a late code gets a clear answer.
"""
from __future__ import annotations

import json
import re
import shlex
from typing import TYPE_CHECKING, Any

from .common import CtlError

if TYPE_CHECKING:
    import argparse

    from .ctl import Ctx, KitIO

SOCKET = 'luady-auth'
SESSION = 'login'
SESSION_TARGET = f'={SESSION}'
# Pane commands need the colon: tmux reads a bare '=login' there as a pane name and finds nothing.
PANE_TARGET = f'={SESSION}:'
DONE_MARK = '[luady-auth exit'
SUCCESS_MARK = 'Login successful'
CODE_PROMPT = 'Paste code here'
PROMPT_TAIL = re.compile(r'^[^\n>]*>[ \t]*')
URL_RE = re.compile(r'https://\S+/oauth/authorize\?\S+', re.ASCII)
CODE_RE = re.compile(r'[A-Za-z0-9._~-]{8,512}(#[A-Za-z0-9._~-]{8,512})?', re.ASCII)
LOGIN_TIMEOUT_SECONDS = 1800
KEEP_SECONDS = 600
URL_WAIT_SECONDS = 20.0
CODE_WAIT_SECONDS = 30.0
POLL_SECONDS = 0.5
STATUS_TIMEOUT_SECONDS = 20.0
PANE_WIDTH = '1000'
CODE_STDIN_MAX = 2048
MESSAGE_MAX = 300


def _tmux(ctx: 'Ctx', *args: str):
    return ctx.run(['tmux', '-L', SOCKET, *args], timeout=10.0)


def _screen(ctx: 'Ctx') -> str | None:
    result = _tmux(ctx, 'capture-pane', '-p', '-J', '-t', PANE_TARGET, '-S', '-200')
    return result.text if result.code == 0 else None


def _waiting(ctx: 'Ctx') -> bool:
    return _tmux(ctx, 'has-session', '-t', SESSION_TARGET).code == 0


def auth_status(ctx: 'Ctx') -> dict[str, Any]:
    """`claude auth status` as {logged_in, email, expires_at}; it prints JSON whether or not it is signed in."""
    result = ctx.run([str(ctx.paths.claude_bin), 'auth', 'status'], timeout=STATUS_TIMEOUT_SECONDS)
    try:
        data = json.loads(result.text)
    except json.JSONDecodeError as exc:
        detail = (result.text or result.stderr.decode('utf-8', 'replace')).strip()[:MESSAGE_MAX]
        raise CtlError('failed', f'claude auth status gave no JSON (exit {result.code}): {detail}') from exc
    if not isinstance(data, dict):
        raise CtlError('failed', 'claude auth status gave unexpected JSON')
    email = data.get('email')
    expires = data.get('loginExpiresAt')
    return {'logged_in': data.get('loggedIn') is True,
            'email': email if isinstance(email, str) else None,
            'expires_at': expires if isinstance(expires, str) else None}


def cmd_auth_status(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    if not ctx.paths.claude_bin.exists():
        raise CtlError('not_found', f'claude is not installed at {ctx.paths.claude_bin}')
    return auth_status(ctx)


def login_script(claude_bin: str) -> str:
    """Fixed shell text (no owner input): run the login with a time limit, print its exit code, keep the pane a while."""
    # --foreground: without it timeout puts claude in a background process group and reading the code stops it.
    return (f'timeout --foreground {LOGIN_TIMEOUT_SECONDS} {shlex.quote(claude_bin)} auth login --claudeai; '
            f'echo "{DONE_MARK} $?]"; sleep {KEEP_SECONDS}')


def cmd_auth_login(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    claude_bin = ctx.paths.claude_bin
    if not claude_bin.exists():
        raise CtlError('not_found', f'claude is not installed at {claude_bin}')
    _tmux(ctx, 'kill-server')
    started = _tmux(ctx, 'new-session', '-d', '-s', SESSION, '-x', PANE_WIDTH, '-y', '50', '-c', str(ctx.paths.home),
                    '--', 'sh', '-c', login_script(str(claude_bin)))
    if started.code != 0:
        raise CtlError('failed', f'tmux could not start the login: {started.stderr.decode("utf-8", "replace").strip()}')
    deadline = ctx.monotonic() + URL_WAIT_SECONDS
    screen = ''
    while ctx.monotonic() < deadline:
        screen = _screen(ctx) or ''
        found = URL_RE.search(screen)
        if found:
            return {'url': found.group(0)}
        if DONE_MARK in screen:
            break
        ctx.sleep(POLL_SECONDS)
    _tmux(ctx, 'kill-server')
    raise CtlError('timeout', f'claude auth login showed no sign-in link: {_last_lines(screen)}')


def _last_lines(screen: str, skip: str = '') -> str:
    lines = [line.strip() for line in screen.splitlines() if line.strip()]
    useful = [line for line in lines if not URL_RE.search(line) and (skip == '' or skip not in line)
              and not line.startswith(DONE_MARK)]
    return ' · '.join(useful[-3:])[:MESSAGE_MAX] or 'no output'


def _read_code(kit_io: 'KitIO') -> str:
    code = kit_io.read_text(CODE_STDIN_MAX).strip()
    if not CODE_RE.fullmatch(code):
        raise CtlError('usage', 'that does not look like a sign-in code')
    return code


def _after_prompt(screen: str, prompts_before: int) -> str:
    """Everything after the code prompt we answered (claude does not echo the code, so the prompt is the anchor)."""
    parts = screen.split(CODE_PROMPT)
    after = CODE_PROMPT.join(parts[prompts_before:]) if len(parts) > prompts_before else ''
    return PROMPT_TAIL.sub('', after, count=1)


def _wait_for_result(ctx: 'Ctx', code: str, prompts_before: int) -> tuple[bool, str]:
    """(signed in, what the login printed). A further code prompt means it rejected the code and waits again."""
    deadline = ctx.monotonic() + CODE_WAIT_SECONDS
    screen = ''
    while ctx.monotonic() < deadline:
        ctx.sleep(POLL_SECONDS)
        screen = _screen(ctx) or ''
        after = _after_prompt(screen, prompts_before)
        if SUCCESS_MARK in after:
            return True, SUCCESS_MARK
        if DONE_MARK in after or CODE_PROMPT in after:
            return False, _last_lines(after, code)
    return False, f'no answer from claude within {int(CODE_WAIT_SECONDS)} s: {_last_lines(screen, code)}'


def cmd_auth_code(ns: 'argparse.Namespace', ctx: 'Ctx', kit_io: 'KitIO') -> dict[str, Any]:
    code = _read_code(kit_io)
    screen = _screen(ctx) if _waiting(ctx) else None
    if screen is None or DONE_MARK in screen or CODE_PROMPT not in screen:
        raise CtlError('not_found', 'no sign-in is waiting (it ends after 30 minutes); start a new one')
    prompts_before = screen.count(CODE_PROMPT)
    _tmux(ctx, 'send-keys', '-t', PANE_TARGET, '-l', '--', code)
    ctx.sleep(0.3)
    _tmux(ctx, 'send-keys', '-t', PANE_TARGET, 'Enter')
    ok, message = _wait_for_result(ctx, code, prompts_before)
    status = auth_status(ctx)
    if ok:
        _tmux(ctx, 'kill-server')
    return {'ok': ok and status['logged_in'], 'message': message, **status}
