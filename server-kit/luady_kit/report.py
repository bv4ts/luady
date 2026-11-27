"""luady-report: a worker session tells Luady, mid-turn, that something the owner waits for is ready.

It writes a spool `report` event for the calling pane; the hub hands it to Luady at once instead of at the turn's Stop.
"""
from __future__ import annotations

import sys
from typing import BinaryIO, TextIO

from . import common, hook

REPORT_MAX = 2000
STDIN_MAX_BYTES = 64 * 1024
USAGE = 'Usage: luady-report "<one short line: what is ready for the owner>"\n'


def _read_text(argv: list[str], stdin: BinaryIO) -> str:
    if argv:
        return ' '.join(argv).strip()
    if stdin.isatty():
        return ''
    return stdin.read(STDIN_MAX_BYTES).decode('utf-8', 'replace').strip()


def main(argv: list[str] | None = None, *, stdin: BinaryIO | None = None, stdout: TextIO | None = None,
         stderr: TextIO | None = None, env: hook.HookEnv | None = None) -> int:
    out, err = stdout or sys.stdout, stderr or sys.stderr
    hook_env = env if env is not None else hook.default_env()
    text = _read_text(sys.argv[1:] if argv is None else argv, stdin if stdin is not None else sys.stdin.buffer)
    if not text:
        err.write(USAGE)
        return common.EXIT_CODES['usage']
    target, _ = hook.tmux_location(hook_env)
    if target is None:
        err.write('luady-report works only inside a Luady tmux session (no $TMUX_PANE).\n')
        return common.EXIT_CODES['refused']
    # cwd and session id stay empty: the hub keeps the pane's own (a subfolder cwd would move it to another project).
    meta = {'session_id': None, 'cwd': None, 'transcript_path': None, 'permission_mode': None, 'tmux': target}
    hook.append(hook_env, common.load_config(hook_env.paths), 'report', meta,
                {'text': hook.redacted_clip(text, REPORT_MAX)[0]})
    out.write('Sent to Luady, who tells the owner now. Carry on with your work.\n')
    return common.EXIT_CODES['ok']
