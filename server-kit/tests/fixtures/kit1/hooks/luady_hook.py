#!/usr/bin/env python3
"""Claude Code hook shim: runs luady_kit.hook from ~/.luady/lib.

It never breaks the session: even a missing or broken kit exits 0 without output.
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
for _candidate in (_ROOT, os.path.join(_ROOT, 'lib')):
    if os.path.isdir(os.path.join(_candidate, 'luady_kit')):
        sys.path.insert(0, _candidate)


def _log_failure(exc: BaseException) -> None:
    try:
        state = os.path.join(os.path.expanduser('~'), '.luady', 'state')
        os.makedirs(state, mode=0o700, exist_ok=True)
        with open(os.path.join(state, 'hook-errors.log'), 'a', encoding='utf-8') as handle:
            handle.write(f'shim: {type(exc).__name__}: {exc}\n')
    except OSError:
        return  # nowhere left to report; the session must still continue


if __name__ == '__main__':
    try:
        from luady_kit.hook import main
        main()
    except BaseException as exc:  # noqa: BLE001 - never break the Claude session
        _log_failure(exc)
    sys.exit(0)
