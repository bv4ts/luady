#!/usr/bin/python3
"""In-image smoke test for fake-claude + the installed server kit (no sshd, no hub).

MSYS_NO_PATHCONV=1 docker run --rm --user dev -e HOME=/home/dev \
  --entrypoint /usr/bin/python3 luady-it-fake-server:latest -I /opt/fake-claude/smoke.py
"""
import json
import os
import subprocess
import sys
import time

HOME = '/home/dev'
LOG = f'{HOME}/.fake-claude/log.jsonl'
CTL = f'{HOME}/.luady/bin/luady-ctl'
TARGET = 'cc-smoke:0.0'
PASTED = 'line one\nسطر ثانٍ 👋 "q" $(whoami) `tick`'


def fail(message: str) -> None:
    sys.exit(f'SMOKE FAIL: {message}')


def run(*args: str, stdin: str | None = None) -> str:
    result = subprocess.run(list(args), input=stdin, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail(f'{" ".join(args)} exited {result.returncode}: {result.stdout}{result.stderr}')
    return result.stdout


def log_entries() -> list:
    try:
        with open(LOG, encoding='utf-8') as fh:
            return [json.loads(line) for line in fh if line.strip()]
    except OSError:
        return []


def spool_events() -> list:
    out = run('python3', '/opt/fake-claude/spool_dump.py')
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def wait(predicate, what: str, source=log_entries, timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        hit = next((e for e in source() if predicate(e)), None)
        if hit is not None:
            return hit
        time.sleep(0.2)
    fail(f'timed out waiting for {what}')
    return {}


def keys(*args: str) -> None:
    run('tmux', 'send-keys', '-t', TARGET, *args)


def type_line(text: str) -> None:
    keys('-l', text)
    keys('Enter')


def mine(sid: str, event: str) -> list:
    return [e for e in spool_events() if e.get('session_id') == sid and e['event'] == event]


def ctl_json(*args: str, stdin: str | None = None) -> dict:
    return json.loads(run(CTL, *args, stdin=stdin))


def check_steps_and_helpers(sid: str) -> None:
    type_line('/tool Bash {"command":"echo hi"}')
    for kind in ('tool_start', 'tool_end'):
        wait(lambda e, k=kind: e.get('session_id') == sid and e['event'] == k and e['data']['title'] == 'echo hi',
             f'spool {kind}', source=spool_events)
    type_line('/agent')
    for kind in ('subagent_start', 'subagent_stop'):
        wait(lambda e, k=kind: e.get('session_id') == sid and e['event'] == k and e['data']['agent_type'] == 'Explore',
             f'spool {kind}', source=spool_events)
    inner = wait(lambda e: e.get('session_id') == sid and e['event'] == 'tool_end' and e['data']['tool'] == 'Grep',
                 'helper Grep step', source=spool_events)
    if inner['data']['agent_type'] != 'Explore' or not inner['data']['agent_id']:
        fail(f'the helper step lost its ids: {inner}')


def check_meters(sid: str) -> None:
    line = wait(lambda e: e['kind'] == 'statusline' and e['sid'] == sid, 'status line output')
    if not line['text'].strip():
        fail('the status line printed nothing')
    wait(lambda e: e.get('session_id') == sid and e['event'] == 'meters', 'spool meters', source=spool_events)
    if len(mine(sid, 'meters')) != 1:
        fail(f'unchanged meters were spooled more than once: {mine(sid, "meters")}')


def check_pause(sid: str) -> None:
    if ctl_json('pause', '--target', TARGET) != {'ok': True, 'paused': True}:
        fail('luady-ctl pause did not pause')
    ends_before = len(mine(sid, 'tool_end'))
    type_line('/steps 5')
    stopped = wait(lambda e: e['kind'] == 'stopped' and e['sid'] == sid, 'turn stopped by the pause')
    if stopped['reason'] != 'Paused by the owner':
        fail(f'unexpected stop reason {stopped}')
    wait(lambda e: e.get('session_id') == sid and e['event'] == 'paused', 'spool paused', source=spool_events)
    time.sleep(2)
    ends = len(mine(sid, 'tool_end')) - ends_before
    if not 1 <= ends < 5:
        fail(f'{ends} steps ended although the session was paused after the first')
    if ctl_json('resume', '--target', TARGET) != {'ok': True, 'was_hit': True, 'sent': True}:
        fail('luady-ctl resume did not report a sent resume')
    wait(lambda e: e['kind'] == 'received' and e['sid'] == sid and e['text'].startswith('The owner has lifted the pause'),
         'resume text typed into the session')


def check_permission(sid: str) -> None:
    type_line('/perm Bash {"command":"rm -rf build"}')
    asked = wait(lambda e: e.get('session_id') == sid and e['event'] == 'permission', 'spool permission',
                 source=spool_events)
    preview = asked['data'].get('preview') or {}
    if preview.get('command') != 'rm -rf build' or preview.get('always') != {'label': 'Bash(rm -rf build)'}:
        fail(f'permission preview: {preview}')
    answer = json.dumps({'behavior': 'allow', 'always': True})
    if ctl_json('permission', '--qid', asked['data']['qid'], stdin=answer) != {'ok': True}:
        fail('luady-ctl permission refused the always answer')
    done = wait(lambda e: e['kind'] == 'permission' and e['sid'] == sid, 'permission decision applied')
    if done['behavior'] != 'allow' or not done['updated']:
        fail(f'the session got {done}')


def check_auth() -> None:
    status = ctl_json('auth-status')
    if (status['logged_in'], status['org_id'], status['plan'], status['email']) != (True, 'org_fake', 'team', None):
        fail(f'auth-status: {status}')
    out = ctl_json('auth-logout')
    if (out['ok'], out['logged_in'], out['message']) != (True, False, 'Signed out'):
        fail(f'auth-logout: {out}')


def main() -> None:
    run('tmux', 'new-session', '-d', '-s', 'cc-smoke', '-c', f'{HOME}/projects/alpha', '--',
        f'{HOME}/.local/bin/claude', '--permission-mode', 'bypassPermissions')
    start = wait(lambda e: e['kind'] == 'start' and e['target'] == TARGET, 'fake-claude start')
    sid = start['sid']
    command = run('tmux', 'display', '-p', '-t', TARGET, '#{pane_current_command}').strip()
    if command != 'claude':
        fail(f'pane_current_command is {command!r}, expected claude')
    panes = json.loads(run(CTL, 'sessions'))['sessions']
    pane = next((p for p in panes if p['target'] == TARGET), None)
    if pane is None or not pane['is_claude'] or not pane['registered'] or pane['session_id'] != sid:
        fail(f'luady-ctl sessions reported {pane}')
    keys('-l', 'smoke hello')
    keys('Enter')
    wait(lambda e: e['kind'] == 'received' and e['text'] == 'smoke hello', 'typed prompt')
    run(CTL, 'send', '--target', TARGET, stdin=PASTED)
    wait(lambda e: e['kind'] == 'received' and e['text'] == PASTED, 'bracketed paste via luady-ctl send')
    for kind in ('session_start', 'prompt', 'stop'):
        wait(lambda e, k=kind: e.get('session_id') == sid and e['event'] == k, f'spool {kind}', source=spool_events)
    if not os.path.exists(f'{HOME}/.fake-claude/skills-first.log'):
        fail('the foreign skills-first.sh hook did not run')
    check_steps_and_helpers(sid)
    check_meters(sid)
    check_pause(sid)
    check_permission(sid)
    check_auth()
    keys('-l', '/exit')
    keys('Enter')
    wait(lambda e: e['kind'] == 'exit' and e['sid'] == sid, 'fake-claude exit')
    wait(lambda e: e.get('session_id') == sid and e['event'] == 'session_end', 'spool session_end', source=spool_events)
    print('SMOKE OK')


if __name__ == '__main__':
    main()
