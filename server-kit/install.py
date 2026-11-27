#!/usr/bin/env python3
"""Install or uninstall the Luady server kit.

Usage: python3 install.py --host-alias cedar [--uninstall] [--skip-settings] [--no-steps] [--home /path]
                          [--projects-root /srv/projects] [--claude-bin /opt/claude/bin/claude]

It needs Python 3.10 or later and says so ({"ok": false, "error": ...} on stderr, exit 1) before importing the kit.
Keep this file parseable by Python 3.6 (no type hints, walrus or f-strings) so an old interpreter reaches that message;
tests/test_install_paths.py checks it.
"""
from __future__ import print_function

import json
import os
import sys

MIN_PYTHON = (3, 10)


def python_version_error(version_info):
    """The refusal for an interpreter older than MIN_PYTHON, or None when it is new enough."""
    if tuple(version_info[:2]) >= MIN_PYTHON:
        return None
    return 'Python {0}.{1} or later is needed (found {2}.{3})'.format(
        MIN_PYTHON[0], MIN_PYTHON[1], version_info[0], version_info[1])


def check_python(version_info=None, stream=None):
    """0 when the interpreter is new enough; else print the refusal as JSON to stream (stderr) and return 1."""
    error = python_version_error(sys.version_info if version_info is None else version_info)
    if error is None:
        return 0
    print(json.dumps({'ok': False, 'error': error}), file=sys.stderr if stream is None else stream)
    return 1


if __name__ == '__main__':
    if check_python():
        sys.exit(1)
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    from luady_kit.install import main
    sys.exit(main())
