"""Installer for the Luady server kit (kit 2).

It copies the kit into ~/.luady, writes state/config.json, and merges the kit's hook entries and its status line into
~/.claude/settings.json. A backup is taken first; every foreign hook is preserved and a foreign status line is chained.

--projects-root and --claude-bin are stored in state/config.json (projects_root, claude_bin) for luady-ctl; a later
install without them keeps the stored values, and --claude-bin is also the binary the `--version` probe runs.

CLI: python3 install.py --host-alias cedar [--uninstall] [--skip-settings] [--no-steps] [--home /path]
                        [--projects-root /srv/projects] [--claude-bin /opt/claude/bin/claude]
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from . import __version__, common

HOOK_MARKER = '/.luady/hooks/luady_'  # matches every kit hook file, kit 1 and kit 2


def guarded(hook_file: str) -> str:
    """The settings command for a kit hook file. It exits 0 (printing nothing) when the file is missing, $HOME is unset
    or python3 is not on PATH, so no state of the kit can block Claude Code (a missing file run directly exits 2)."""
    path = f'"$HOME/.luady/hooks/{hook_file}"'
    if hook_file.endswith('.sh'):
        return f"sh -c '[ -f {path} ] || exit 0; exec sh {path}'"
    return f"sh -c '[ -f {path} ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; exec python3 {path}'"


HOOK_COMMAND = guarded('luady_hook.py')
STEP_COMMAND = guarded('luady_step.py')
PAUSE_COMMAND = guarded('luady_pause.sh')
STATUSLINE_COMMAND = guarded('luady_statusline.py')
STATUSLINE_MARKER = '/.luady/hooks/luady_statusline.py'
ASYNC_MIN_VERSION = (2, 1, 295)  # the version the kit's first async hooks were verified on
PAUSE_TIMEOUT_SECONDS = 5
WAIT_TIMEOUT_SECONDS = 86460
CLAUDE_VERSION_TIMEOUT_SECONDS = 15.0
SEMVER = re.compile(r'([0-9]+)\.([0-9]+)\.([0-9]+)', re.ASCII)
CODE_DIRS = ('lib', 'bin', 'hooks')
# Uninstall removes lib/ and bin/ but leaves every hook file as an exit-0 stub: a session that still has the old
# registration would otherwise run `python3 <missing file>` or `sh <missing file>`, which exit 2 = "block".
REMOVED_ON_UNINSTALL = ('lib', 'bin')
HOOK_FILES = ('luady_hook.py', 'luady_step.py', 'luady_pause.sh', 'luady_statusline.py')
HOOK_STUB = (
    b'#!/usr/bin/env python3\n'
    b'"""Luady kit uninstalled. Stale hook registrations may still call this file: exit 0 so no session is blocked."""\n'
    b'import sys\n'
    b'sys.exit(0)\n'
)
SH_STUB = b'#!/bin/sh\n# Luady kit uninstalled. Stale hook registrations may still call this file.\nexit 0\n'
STATUSLINE_NOT_COMMAND = 'skipped: the existing statusLine is not a command'
PATH_RULE = 'an absolute path of letters, digits and . _ / - only (at most 256 characters, no "..")'


class InstallError(Exception):
    """The installer refused to continue."""


def path_options(projects_root: str | None, claude_bin: str | None) -> dict[str, str]:
    """The given --projects-root / --claude-bin keyed as in config.json. A value off common.PATH_SETTING_RE is
    refused; the message names only the option and the rule, never the value."""
    given = {'projects_root': projects_root, 'claude_bin': claude_bin}
    for key, value in given.items():
        if value is not None and not common.matches(common.PATH_SETTING_RE, value):
            raise InstallError(f"--{key.replace('_', '-')} must be {PATH_RULE}")
    return {key: value for key, value in given.items() if value is not None}


def _handler(command: str, options: dict[str, Any]) -> dict[str, Any]:
    return {'type': 'command', 'command': command, **options}


def hook_spec(steps: bool = True, pause: bool = True, failure_event: bool = True) -> dict[str, list[dict[str, Any]]]:
    """The kit's hook table as settings.json groups (a fresh object on every call).

    - the eight kit-1 entries, unchanged;
    - steps: luady_step.py, async, on PreToolUse/PostToolUse (`*`), SubagentStart, SubagentStop;
    - steps also on PostToolUseFailure (failure summaries) when failure_event is set, i.e. only for a Claude Code
      version known to have that event;
    - pause: luady_pause.sh, synchronous, on PostToolUse only. A stop printed after a failed call is not honoured, the
      pause takes effect at the next successful call. A reinstall drops the failure-event pause entry an earlier kit 2
      wrote, because every kit entry is stripped before the table is merged.
    """
    def old(options: dict[str, Any]) -> dict[str, Any]:
        return _handler(HOOK_COMMAND, options)

    step = {'hooks': [_handler(STEP_COMMAND, {'async': True})]}
    check = {'hooks': [_handler(PAUSE_COMMAND, {'timeout': PAUSE_TIMEOUT_SECONDS})]}
    spec: dict[str, list[dict[str, Any]]] = {
        'SessionStart': [{'hooks': [old({'timeout': 5})]}],
        'UserPromptSubmit': [{'hooks': [old({'async': True})]}],
        'Stop': [{'hooks': [old({'async': True})]}],
        'StopFailure': [{'hooks': [old({'async': True})]}],
        'Notification': [{'hooks': [old({'async': True})]}],
        'SessionEnd': [{'hooks': [old({'async': True})]}],
        'PreToolUse': [{'matcher': 'AskUserQuestion', 'hooks': [old({'timeout': WAIT_TIMEOUT_SECONDS})]}],
        'PermissionRequest': [{'hooks': [old({'timeout': WAIT_TIMEOUT_SECONDS})]}],
    }
    tool_events = ('PostToolUse', 'PostToolUseFailure') if failure_event else ('PostToolUse',)
    if steps:
        spec['PreToolUse'] = [*spec['PreToolUse'], {'matcher': '*', **copy.deepcopy(step)}]
        for event in tool_events:
            spec[event] = [{'matcher': '*', **copy.deepcopy(step)}]
        spec['SubagentStart'] = [copy.deepcopy(step)]
        spec['SubagentStop'] = [copy.deepcopy(step)]
    if pause:
        spec['PostToolUse'] = [*spec.get('PostToolUse', []), copy.deepcopy(check)]
    return spec


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
    """A deep copy of settings without any handler whose command contains /.luady/hooks/luady_ (all kit hooks)."""
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


def merge_luady_hooks(settings: dict[str, Any], spec: dict[str, list[dict[str, Any]]] | None = None) -> dict[str, Any]:
    """Foreign hooks first, then exactly one copy of every Luady entry (idempotent)."""
    base = strip_luady_hooks(settings)
    hooks = dict(base.get('hooks') or {})
    for event, groups in (spec if spec is not None else hook_spec()).items():
        existing = hooks.get(event, [])
        if not isinstance(existing, list):
            raise InstallError(f'settings.json hooks.{event} is not a list; fix it by hand first')
        hooks[event] = [*existing, *groups]
    return {**base, 'hooks': hooks}


def _is_our_statusline(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get('command'), str) and STATUSLINE_MARKER in value['command']


def merge_statusline(settings: dict[str, Any], paths: common.KitPaths) -> tuple[dict[str, Any], str]:
    """Put the kit's status line in settings. A foreign `command` status line is saved to state/statusline-chain.json
    (the kit's script runs it and shows its output) and ours takes its place with its other keys; a foreign status
    line of another type is left alone. Returns (new settings, 'installed' | 'kept' | 'wrapped' | 'skipped: …')."""
    current = settings.get('statusLine')
    ours = {'type': 'command', 'command': STATUSLINE_COMMAND}
    if current is None:
        return {**copy.deepcopy(settings), 'statusLine': ours}, 'installed'
    if _is_our_statusline(current):
        return copy.deepcopy(settings), 'kept'
    if not isinstance(current, dict) or current.get('type') != 'command' or not isinstance(current.get('command'), str):
        return copy.deepcopy(settings), STATUSLINE_NOT_COMMAND
    paths.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    common.atomic_write_json(paths.statusline_chain, current)
    return {**copy.deepcopy(settings), 'statusLine': {**copy.deepcopy(current), **ours}}, 'wrapped'


def restore_statusline(settings: dict[str, Any], paths: common.KitPaths) -> dict[str, Any]:
    """Settings with the saved foreign status line back in our place (same key position), or without ours.
    A status line that is not ours is never touched. The caller deletes the chain file after writing."""
    if not _is_our_statusline(settings.get('statusLine')):
        return copy.deepcopy(settings)
    saved = common.read_json_or_none(paths.statusline_chain)
    if isinstance(saved, dict):
        return {key: (saved if key == 'statusLine' else copy.deepcopy(value)) for key, value in settings.items()}
    return {key: copy.deepcopy(value) for key, value in settings.items() if key != 'statusLine'}


def claude_version(paths: common.KitPaths) -> tuple[int, int, int] | None:
    """From `<claude> --version`; None when Claude Code is missing or the output is unreadable."""
    result = common.run_process([str(paths.claude_bin), '--version'], timeout=CLAUDE_VERSION_TIMEOUT_SECONDS)
    match = SEMVER.search(result.text) if result.code == 0 else None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))) if match else None


def steps_supported(version: tuple[int, int, int] | None) -> bool:
    return version is not None and version >= ASYNC_MIN_VERSION


def steps_summary(version: tuple[int, int, int] | None, no_steps: bool) -> str:
    if no_steps:
        return 'off: --no-steps was given'
    if steps_supported(version):
        return 'on'
    shown = '.'.join(map(str, version)) if version else 'unknown'
    minimum = '.'.join(map(str, ASYNC_MIN_VERSION))
    return f'off: Claude Code {shown} is older than {minimum}, asynchronous hooks are not verified'


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
    """Atomic: a temp file in the settings folder, then os.replace (a symlinked settings.json is followed)."""
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
    for hook_file in sorted((src / 'hooks').iterdir()):  # the code first: settings refer to these files only later
        if hook_file.is_file():
            _copy_text(hook_file, paths.hooks / hook_file.name, 0o755)


def stored_paths(home: Path) -> dict[str, str]:
    """The projects_root / claude_bin an earlier install stored in config.json (valid ones only)."""
    return common.stored_path_settings(common.read_json_or_none(common.KitPaths(home).config_file))


def write_config(paths: common.KitPaths, host_alias: str, given: Mapping[str, str] | None = None) -> dict[str, Any]:
    """config.json with this host alias. A path setting given now replaces the stored one; without it the stored one
    is kept."""
    existing = common.read_json_or_none(paths.config_file)
    current = common.load_config(paths) if isinstance(existing, dict) else common.default_config(host_alias)
    path_settings = {**common.stored_path_settings(existing), **(given or {})}
    config = common.config_for_file({**current, 'host_alias': host_alias}, path_settings)
    common.atomic_write_json(paths.config_file, config)
    return config


def install(home: Path, host_alias: str, src: Path, now: datetime, skip_settings: bool = False,
            no_steps: bool = False, projects_root: str | None = None, claude_bin: str | None = None) -> dict[str, Any]:
    """Copy the code, then (unless --skip-settings) merge the hooks and the status line. Settings and options are
    validated before anything changes; step hooks are added only on a Claude Code version with verified async hooks.
    The version probe runs --claude-bin when given, else the stored claude_bin, else ~/.local/bin/claude."""
    if not common.matches(common.HOST_ALIAS_RE, host_alias):
        raise InstallError('--host-alias must match [A-Za-z0-9._-]{1,32}')
    given = path_options(projects_root, claude_bin)
    if not home.is_dir():
        raise InstallError(f'home directory {home} does not exist')
    paths = common.configured_paths(home, {**stored_paths(home), **given})
    version = None if skip_settings else claude_version(paths)
    supported = steps_supported(version)
    spec = hook_spec(steps=supported and not no_steps, pause=True, failure_event=supported)
    if not skip_settings:
        merge_luady_hooks(read_settings(paths.claude_settings) or {}, spec)  # refuse odd settings before any change
    common.ensure_runtime_dirs(paths)
    copy_kit(src, paths)
    config = write_config(paths, host_alias, given)
    backup, statusline = None, 'skipped: --skip-settings'
    if not skip_settings:
        # Read and merge again right before the (atomic) write, so a change made meanwhile is kept.
        merged, statusline = merge_statusline(merge_luady_hooks(read_settings(paths.claude_settings) or {}, spec),
                                              paths)
        backup = backup_settings(paths, now)
        write_settings(paths, merged)
    return {'ok': True, 'action': 'install', 'version': __version__, 'home': str(home),
            'host_alias': config['host_alias'],
            'projects_root': config.get('projects_root', common.default_projects_root(home)),  # what luady-ctl will use
            'claude_bin': config.get('claude_bin'),  # null: ~/.local/bin/claude
            'settings': None if skip_settings else str(paths.claude_settings),
            'backup': str(backup) if backup else None,
            'steps': 'off: --skip-settings' if skip_settings else steps_summary(version, no_steps),
            'statusline': statusline}


def write_stubs(paths: common.KitPaths) -> None:
    """An exit-0 stub over every kit hook file, the four of kit 2 and any other luady_* file found there."""
    paths.hooks.mkdir(mode=0o755, parents=True, exist_ok=True)
    names = set(HOOK_FILES) | {path.name for path in paths.hooks.glob('luady_*') if path.is_file()}
    for name in sorted(names):
        common.atomic_write_bytes(paths.hooks / name, SH_STUB if name.endswith('.sh') else HOOK_STUB, 0o755)


def uninstall(home: Path, now: datetime) -> dict[str, Any]:
    paths = common.KitPaths(home)
    settings = read_settings(paths.claude_settings)
    backup, statusline = None, 'none'
    if settings is not None:
        restored = restore_statusline(strip_luady_hooks(settings), paths)
        if _is_our_statusline(settings.get('statusLine')):
            statusline = 'restored' if 'statusLine' in restored else 'removed'
        backup = backup_settings(paths, now)
        write_settings(paths, restored)
        if statusline != 'none':
            paths.statusline_chain.unlink(missing_ok=True)
    for name in REMOVED_ON_UNINSTALL:
        shutil.rmtree(paths.root / name, ignore_errors=True)
    write_stubs(paths)
    return {'ok': True, 'action': 'uninstall', 'home': str(home), 'settings': str(paths.claude_settings),
            'backup': str(backup) if backup else None, 'kept': str(paths.root), 'statusline': statusline}


def default_source() -> Path:
    return Path(__file__).resolve().parent.parent


def main(argv: Sequence[str] | None = None, *, now: datetime | None = None, src: Path | None = None) -> int:
    parser = argparse.ArgumentParser(prog='install.py', description='Install the Luady server kit into ~/.luady.')
    parser.add_argument('--host-alias', help='name Luady uses for this machine: cedar, birch, ash, or hq for the self host')
    parser.add_argument('--uninstall', action='store_true', help='remove only the Luady hook entries and kit code')
    parser.add_argument('--home', help='home directory to install into (default: $HOME)')
    parser.add_argument('--skip-settings', action='store_true',
                        help='install code only; do not touch ~/.claude/settings.json (the self host hq, whose manager hooks come from --settings)')
    parser.add_argument('--no-steps', action='store_true',
                        help='do not register the asynchronous step hooks (tool and helper events)')
    parser.add_argument('--projects-root', metavar='PATH',
                        help='absolute folder holding the git repos luady-ctl works on (default: the stored one, '
                             'else ~/projects of the home it installs into)')
    parser.add_argument('--claude-bin', metavar='PATH',
                        help='absolute path of the Claude Code binary (default: the stored one, else '
                             '~/.local/bin/claude)')
    ns = parser.parse_args(argv)
    if not ns.uninstall and not ns.host_alias:
        parser.error('--host-alias is required unless --uninstall is given')
    home = Path(ns.home) if ns.home else common.KitPaths.from_env().home
    moment = now or common.utc_now()
    try:
        if ns.uninstall:
            result = uninstall(home, moment)
        else:
            result = install(home, ns.host_alias, src or default_source(), moment, skip_settings=ns.skip_settings,
                             no_steps=ns.no_steps, projects_root=ns.projects_root, claude_bin=ns.claude_bin)
    except InstallError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0
