"""Fake Claude Code TUI for kit tests (runs inside tmux panes).

- `--version` prints the version stored next to this file (default 2.1.295); `update` bumps it to 2.1.296.
- Otherwise it appends JSON lines to <cwd>/.fake_claude.jsonl: start (argv), trust_accepted, ready, submit, key.
- A submitted `/tool` runs `sh ~/.luady/hooks/luady_pause.sh` (the kit's pause check) and logs pause_hook.
- <cwd>/.fake_trust shows a folder-trust dialog first; <cwd>/.fake_ignore_exit makes it ignore /exit.
- After start it writes a ~/.luady/registry entry like the kit's SessionStart hook (when that dir exists).
- It enables bracketed paste and extended keys: pastes decode CR -> LF and Shift+Enter (CSI 13;2u) inserts a newline.
"""
import datetime
import json
import os
import select
import subprocess
import sys
import termios
import tty

PASTE_START = b'\x1b[200~'
PASTE_END = b'\x1b[201~'
SHIFT_ENTER = b'\x1b[13;2u'  # tmux sends this for `send-keys S-Enter` once the app enabled extended keys
SEQUENCES = (PASTE_START, SHIFT_ENTER)
VALUE_FLAGS = {'--permission-mode', '--model', '--resume', '--settings', '--remote-control'}
VERSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.fake_claude_version')


def log(event):
    with open(os.path.join(os.getcwd(), '.fake_claude.jsonl'), 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + '\n')


def current_version():
    try:
        with open(VERSION_FILE, encoding='utf-8') as handle:
            return handle.read().strip() or '2.1.295'
    except OSError:
        return '2.1.295'


def flag_value(args, flag):
    for index, arg in enumerate(args[:-1]):
        if arg == flag:
            return args[index + 1]
    return None


def positional_prompt(args):
    skip, prompt = False, None
    for arg in args:
        if skip:
            skip = False
        elif arg in VALUE_FLAGS:
            skip = True
        elif not arg.startswith('--'):
            prompt = arg
    return prompt


def session_id(args):
    return flag_value(args, '--resume') or f'fake-{os.getpid()}'


def run_pause_hook(sid):
    """`/tool`: run the kit's synchronous pause check like Claude Code after a tool call (own env, JSON on stdin)."""
    script = os.path.join(os.path.expanduser('~'), '.luady', 'hooks', 'luady_pause.sh')
    payload = {'session_id': sid, 'transcript_path': None, 'cwd': os.getcwd(), 'permission_mode': 'bypassPermissions',
               'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'tool_input': {'command': 'true'},
               'tool_response': {}, 'tool_use_id': 'toolu_fake'}
    result = subprocess.run(['sh', script], input=json.dumps(payload).encode('utf-8'), capture_output=True)
    log({'type': 'pause_hook', 'code': result.returncode, 'stdout': result.stdout.decode('utf-8', 'replace')})


def register(args):
    registry = os.path.join(os.path.expanduser('~'), '.luady', 'registry')
    pane = os.environ.get('TMUX_PANE')
    if not pane or not os.path.isdir(registry):
        return
    shown = subprocess.run(['tmux', 'display-message', '-p', '-t', pane, '#S:#I.#P\t#{pane_pid}'],
                           capture_output=True, text=True).stdout.strip()
    target, _, pane_pid = shown.partition('\t')
    sid = session_id(args)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    entry = {'session_id': sid, 'transcript_path': None, 'cwd': os.getcwd(), 'tmux': target,
             'source': 'resume' if '--resume' in args else 'startup', 'started_at': now,
             'pane_pid': int(pane_pid) if pane_pid.isdigit() else None}
    tmp = os.path.join(registry, f'.{sid}.tmp')
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(entry, handle)
    os.replace(tmp, os.path.join(registry, f'{sid}.json'))


def handle_byte(byte, state):
    if state['paste']:
        state['buffer'] += b'\n' if byte == b'\r' else byte
    elif byte == b'\r':
        text = state['buffer'].decode('utf-8')
        state['buffer'] = b''
        log({'type': 'submit', 'text': text})
        if text == '/exit' and not state['ignore_exit']:
            state['exit'] = True
        elif text == '/tool':
            run_pause_hook(state['sid'])
    elif byte == b'\x03':
        log({'type': 'key', 'key': 'C-c'})
    else:
        state['buffer'] += byte


def consume(data, state):
    """Process input bytes; returns an unconsumed tail (a possibly incomplete paste marker)."""
    index = 0
    while index < len(data) and not state['exit']:
        if data.startswith(PASTE_START, index):
            state['paste'], index = True, index + len(PASTE_START)
            continue
        if data.startswith(PASTE_END, index):
            state['paste'], index = False, index + len(PASTE_END)
            continue
        if data.startswith(SHIFT_ENTER, index) and not state['paste']:
            state['buffer'] += b'\n'
            index += len(SHIFT_ENTER)
            continue
        if data[index:index + 1] == b'\x1b' and not state['paste']:
            rest = data[index:]
            if any(len(rest) < len(seq) and seq.startswith(rest) for seq in SEQUENCES):
                return rest
            log({'type': 'key', 'key': 'Escape'})
        else:
            handle_byte(data[index:index + 1], state)
        index += 1
    return b''


def tui_loop(fd, state):
    pending = b''
    while not state['exit']:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            if pending:
                log({'type': 'key', 'key': 'Escape'})
                pending = consume(pending[1:], state)
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            return
        pending = consume(pending + chunk, state)


TRUST_OPTIONS = ('No, exit', 'Yes, I trust this folder')


def draw_trust(selected):
    rows = [('\u276f ' if index == selected else '  ') + label for index, label in enumerate(TRUST_OPTIONS)]
    sys.stdout.write('\x1b[2J\x1b[HDo you trust the files in this folder?\r\n\r\n' + '\r\n'.join(rows) + '\r\n')
    sys.stdout.flush()


def trust_dialog(fd):
    """Claude Code 2.1.296: "No, exit" is preselected; only Down moves to Yes, and Enter confirms the selection."""
    selected = 0
    draw_trust(selected)
    while True:
        chunk = os.read(fd, 64)
        if not chunk:
            sys.exit(0)
        if b'\x1b[B' in chunk or b'\x1bOB' in chunk:
            selected = 1
            draw_trust(selected)
        elif b'\r' in chunk:
            if selected == 0:
                log({'type': 'trust_declined'})
                sys.exit(0)
            log({'type': 'trust_accepted'})
            sys.stdout.write('\x1b[2J\x1b[H')
            sys.stdout.flush()
            return


def main():
    args = sys.argv[1:]
    if args[:1] == ['--version']:
        print(f'{current_version()} (Claude Code)')
        return 0
    if args[:1] == ['update']:
        with open(VERSION_FILE, 'w', encoding='utf-8') as handle:
            handle.write('2.1.296')
        print('Updated Claude Code from 2.1.295 to 2.1.296')
        return 0
    log({'type': 'start', 'argv': args, 'pid': os.getpid()})
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    try:
        if os.path.exists('.fake_trust'):
            trust_dialog(fd)
        register(args)
        prompt = positional_prompt(args)
        if prompt is not None:
            log({'type': 'submit', 'text': prompt})
        sys.stdout.write('\x1b[>4;2m\x1b[?2004hFAKE CLAUDE READY\r\n> ')
        sys.stdout.flush()
        log({'type': 'ready'})
        state = {'paste': False, 'buffer': b'', 'exit': False, 'ignore_exit': os.path.exists('.fake_ignore_exit'),
                 'sid': session_id(args)}
        tui_loop(fd, state)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
    return 0


if __name__ == '__main__':
    sys.exit(main())
