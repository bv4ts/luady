#!/usr/bin/env python3
"""Claude Code status-line shim (kit 2): runs luady_kit.statusline from ~/.luady/lib.

It never breaks the session: it always exits 0. Without the kit-2 lib (the lib folder deleted, or a kit-1 install or
uninstall run over kit 2) it shows the owner's chained status line from ~/.luady/state/statusline-chain.json if there
is one, else an empty line, and logs nothing.
"""
import json
import os
import subprocess
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
for _candidate in (_ROOT, os.path.join(_ROOT, 'lib')):
    if os.path.isdir(os.path.join(_candidate, 'luady_kit')):
        sys.path.insert(0, _candidate)

CHAIN_TIMEOUT_SECONDS = 2.0
STDIN_MAX_BYTES = 4 * 1024 * 1024


def _log_failure(exc: BaseException) -> None:
    try:
        state = os.path.join(os.path.expanduser('~'), '.luady', 'state')
        os.makedirs(state, mode=0o700, exist_ok=True)
        with open(os.path.join(state, 'hook-errors.log'), 'a', encoding='utf-8') as handle:
            handle.write(f'status line shim: {type(exc).__name__}: {exc}\n')
    except OSError:
        return  # nowhere left to report; the session must still continue


def _without_kit() -> None:
    """The chained status line's output for the same input, or an empty line."""
    out = b'\n'
    try:
        raw = sys.stdin.buffer.read(STDIN_MAX_BYTES)
        path = os.path.join(os.path.expanduser('~'), '.luady', 'state', 'statusline-chain.json')
        with open(path, encoding='utf-8') as handle:
            command = json.load(handle).get('command')
        if isinstance(command, str) and command.strip():
            result = subprocess.run(['sh', '-c', command], input=raw, capture_output=True,
                                    timeout=CHAIN_TIMEOUT_SECONDS, check=False)
            out = result.stdout or out
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        pass  # no chain, or it failed: the empty line stands
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        from luady_kit.statusline import main
    except ModuleNotFoundError as exc:
        if exc.name not in ('luady_kit', 'luady_kit.statusline'):
            _log_failure(exc)
        try:
            _without_kit()
        except BaseException:  # noqa: BLE001 - never break the Claude session
            pass
        sys.exit(0)
    except BaseException as exc:  # noqa: BLE001 - never break the Claude session
        _log_failure(exc)
        sys.exit(0)
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 - never break the Claude session
        _log_failure(exc)
    sys.exit(0)
