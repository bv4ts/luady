#!/usr/bin/env python3
"""Claude Code step hook shim (kit 2): runs luady_kit.steps from ~/.luady/lib. Registered with "async": true.

It never breaks the session: it always exits 0 and prints nothing. Without the kit-2 lib (the lib folder deleted, or
a kit-1 install or uninstall run over kit 2) it does nothing at all, not even log, since it would run per tool call.
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
            handle.write(f'step shim: {type(exc).__name__}: {exc}\n')
    except OSError:
        return  # nowhere left to report; the session must still continue


if __name__ == '__main__':
    try:
        from luady_kit.steps import main
    except ModuleNotFoundError as exc:
        if exc.name not in ('luady_kit', 'luady_kit.steps'):
            _log_failure(exc)
        sys.exit(0)
    except BaseException as exc:  # noqa: BLE001 - never break the Claude session
        _log_failure(exc)
        sys.exit(0)
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 - never break the Claude session
        _log_failure(exc)
    sys.exit(0)
