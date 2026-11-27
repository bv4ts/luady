"""Installer for the Luady server kit.

It copies the kit into ~/.luady, writes state/config.json, and merges the kit's hook entries into
~/.claude/settings.json. A backup is taken first and every foreign hook is preserved.

CLI: python3 install.py --host-alias cedar [--uninstall] [--skip-settings] [--home /path]
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

from . import __version__, common

HOOK_MARKER = '/.luady/hooks/luady_hook.py'
HOOK_COMMAND = 'python3 "$HOME/.luady/hooks/luady_hook.py"'
WAIT_TIMEOUT_SECONDS = 86460
CODE_DIRS = ('lib', 'bin', 'hooks')
# Uninstall removes lib/ and bin/ but leaves hooks/luady_hook.py as this stub: a session that still has the old
# hook registration would otherwise run `python3 <missing file>`, which exits 2 = "block" and swallows prompts.
REMOVED_ON_UNINSTALL = ('lib', 'bin')
HOOK_STUB = (
    b'#!/usr/bin/env python3\n'
    b'"""Luady kit uninstalled. Stale hook registrations may still call this file: exit 0 so no session is blocked."""\n'
    b'import sys\n'
    b'sys.exit(0)\n'
)


class InstallError(Exception):
    """The installer refused to continue."""


def hook_spec() -> dict[str, list[dict[str, Any]]]:
    """The hook table as settings.json groups (a fresh object on every call)."""
    def handler(options: dict[str, Any]) -> dict[str, Any]:
        return {'type': 'command', 'command': HOOK_COMMAND, **options}

    return {
        'SessionStart': [{'hooks': [handler({'timeout': 5})]}],
        'UserPromptSubmit': [{'hooks': [handler({'async': True})]}],
        'Stop': [{'hooks': [handler({'async': True})]}],
        'StopFailure': [{'hooks': [handler({'async': True})]}],
        'Notification': [{'hooks': [handler({'async': True})]}],
        'SessionEnd': [{'hooks': [handler({'async': True})]}],
        'PreToolUse': [{'matcher': 'AskUserQuestion', 'hooks': [handler({'timeout': WAIT_TIMEOUT_SECONDS})]}],
        'PermissionRequest': [{'hooks': [handler({'timeout': WAIT_TIMEOUT_SECONDS})]}],
    }


def _is_luady(handler: Any) -> bool:
    return isinstance(handler, dict) and isinstance(handler.get('command'), str) and HOOK_MARKER in handler['command']


def _strip_group(group: Any) -> Any:
    if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
        return group
    remaining = [handler for handler in group['hooks'] if not _is_luady(handler)]
    if len(remaining) == len(group['hooks']):
        return group
    return {**group, 'hooks': remaining} if remaining else None


def _strip_event(groups: Any) -> Any:
    if not isinstance(groups, list):
        return groups
    kept = [group for group in map(_strip_group, groups) if group is not None]
    return kept if kept or not groups else None


def strip_luady_hooks(settings: dict[str, Any]) -> dict[str, Any]:
    """A deep copy of settings without any handler whose command contains /.luady/hooks/luady_hook.py."""
    hooks = settings.get('hooks')
    if hooks is not None and not isinstance(hooks, dict):
        raise InstallError('settings.json "hooks" is not an object; fix it by hand first')
    stripped = {event: _strip_event(groups) for event, groups in copy.deepcopy(hooks or {}).items()}
    cleaned = {event: groups for event, groups in stripped.items() if groups is not None}
    result: dict[str, Any] = {}
    for key, value in settings.items():
        if key != 'hooks':
            result[key] = copy.deepcopy(value)
        elif cleaned:
            result[key] = cleaned
    return result


def merge_luady_hooks(settings: dict[str, Any]) -> dict[str, Any]:
    """Foreign hooks first, then exactly one copy of every Luady entry (idempotent)."""
    base = strip_luady_hooks(settings)
    hooks = dict(base.get('hooks') or {})
    for event, groups in hook_spec().items():
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            raise InstallError(f'settings.json hooks.{event} is not a list; fix it by hand first')
        hooks[event] = [*existing, *groups]
    return {**base, 'hooks': hooks}


def read_settings(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InstallError(f'{path} is not valid JSON ({exc}); nothing was changed') from exc
    if not isinstance(data, dict):
        raise InstallError(f'{path} must contain a JSON object; nothing was changed')
    return data


def backup_settings(paths: common.KitPaths, now: datetime) -> Path | None:
    if not paths.claude_settings.exists():
        return None
    paths.backup.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = common.compact_stamp(now)
    target, counter = paths.backup / f'settings-{stamp}.json', 1
    while target.exists():
        target, counter = paths.backup / f'settings-{stamp}-{counter}.json', counter + 1
    shutil.copy2(paths.claude_settings, target)
    return target


def write_settings(paths: common.KitPaths, settings: dict[str, Any]) -> None:
    target = Path(os.path.realpath(paths.claude_settings))
    mode = target.stat().st_mode & 0o777 if target.exists() else 0o600
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    common.atomic_write_bytes(target, common.dumps_pretty(settings), mode)


def _copy_text(src: Path, dest: Path, mode: int) -> None:
    dest.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    common.atomic_write_bytes(dest, src.read_bytes().replace(b'\r\n', b'\n'), mode)


def copy_kit(src: Path, paths: common.KitPaths) -> None:
    sources = sorted((src / 'luady_kit').glob('*.py'))
    if not sources:
        raise InstallError(f'no kit sources under {src / "luady_kit"}')
    lib = paths.lib / 'luady_kit'
    for path in sources:
        _copy_text(path, lib / path.name, 0o644)
    names = {path.name for path in sources}
    for stale in lib.glob('*.py'):
        if stale.name not in names:
            stale.unlink()
    shutil.rmtree(lib / '__pycache__', ignore_errors=True)
    for shim in sorted((src / 'bin').iterdir()):
        if shim.is_file():
            _copy_text(shim, paths.bin / shim.name, 0o755)
    _copy_text(src / 'hooks' / 'luady_hook.py', paths.hooks / 'luady_hook.py', 0o755)


def write_config(paths: common.KitPaths, host_alias: str) -> dict[str, Any]:
    existing = common.read_json_or_none(paths.config_file)
    current = common.load_config(paths) if isinstance(existing, dict) else common.default_config(host_alias)
    config = {**current, 'host_alias': host_alias}
    common.atomic_write_json(paths.config_file, config)
    return config


def install(home: Path, host_alias: str, src: Path, now: datetime, skip_settings: bool = False) -> dict[str, Any]:
    if not common.matches(common.HOST_ALIAS_RE, host_alias):
        raise InstallError('--host-alias must match [A-Za-z0-9._-]{1,32}')
    if not home.is_dir():
        raise InstallError(f'home directory {home} does not exist')
    paths = common.KitPaths(home)
    merged = None if skip_settings else merge_luady_hooks(read_settings(paths.claude_settings) or {})
    common.ensure_runtime_dirs(paths)
    copy_kit(src, paths)
    config = write_config(paths, host_alias)
    backup = None
    if merged is not None:
        backup = backup_settings(paths, now)
        write_settings(paths, merged)
    return {'ok': True, 'action': 'install', 'version': __version__, 'home': str(home),
            'host_alias': config['host_alias'], 'settings': None if skip_settings else str(paths.claude_settings),
            'backup': str(backup) if backup else None}


def uninstall(home: Path, now: datetime) -> dict[str, Any]:
    paths = common.KitPaths(home)
    settings = read_settings(paths.claude_settings)
    backup = None
    if settings is not None:
        stripped = strip_luady_hooks(settings)
        backup = backup_settings(paths, now)
        write_settings(paths, stripped)
    for name in REMOVED_ON_UNINSTALL:
        shutil.rmtree(paths.root / name, ignore_errors=True)
    paths.hooks.mkdir(mode=0o755, parents=True, exist_ok=True)
    common.atomic_write_bytes(paths.hooks / 'luady_hook.py', HOOK_STUB, 0o755)
    return {'ok': True, 'action': 'uninstall', 'home': str(home), 'settings': str(paths.claude_settings),
            'backup': str(backup) if backup else None, 'kept': str(paths.root)}


def default_source() -> Path:
    return Path(__file__).resolve().parent.parent


def main(argv: Sequence[str] | None = None, *, now: datetime | None = None, src: Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog='install.py', description='Install the Luady server kit into ~/.luady.')
    parser.add_argument('--host-alias', help='name Luady uses for this machine: cedar, birch, ash or luady')
    parser.add_argument('--uninstall', action='store_true', help='remove only the Luady hook entries and kit code')
    parser.add_argument('--home', help='home directory to install into (default: $HOME)')
    parser.add_argument('--skip-settings', action='store_true',
                        help='install code only; do not touch ~/.claude/settings.json (the luady brain host, whose hooks come from --settings)')
    ns = parser.parse_args(argv)
    if not ns.uninstall and not ns.host_alias:
        parser.error('--host-alias is required unless --uninstall is given')
    home = Path(ns.home) if ns.home else common.KitPaths.from_env().home
    moment = now or common.utc_now()
    try:
        if ns.uninstall:
            result = uninstall(home, moment)
        else:
            result = install(home, ns.host_alias, src or default_source(), moment, skip_settings=ns.skip_settings)
    except InstallError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0
