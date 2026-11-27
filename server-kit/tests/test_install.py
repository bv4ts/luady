"""install.py: layout, config, settings merge that keeps foreign hooks, idempotency, uninstall and shims."""
from __future__ import annotations

import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock
from datetime import datetime, timezone
from pathlib import Path

from luady_kit import __version__, common, install
from tests.helpers import read_spool

KIT_ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)
KIT1_COMMAND = 'python3 "$HOME/.luady/hooks/luady_hook.py"'  # what kit 1 registered
LUADY_COMMAND = ("sh -c '[ -f \"$HOME/.luady/hooks/luady_hook.py\" ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; "
                "exec python3 \"$HOME/.luady/hooks/luady_hook.py\"'")
FOREIGN = {'model': 'opus', 'remoteControlAtStartup': True, 'hooks': {
    'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': '~/.claude/hooks/skills-first.sh'}]}],
    'PreToolUse': [{'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'audit.sh'}]}]}}


STEP_COMMAND = ("sh -c '[ -f \"$HOME/.luady/hooks/luady_step.py\" ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; "
                "exec python3 \"$HOME/.luady/hooks/luady_step.py\"'")
PAUSE_COMMAND = "sh -c '[ -f \"$HOME/.luady/hooks/luady_pause.sh\" ] || exit 0; exec sh \"$HOME/.luady/hooks/luady_pause.sh\"'"
STATUSLINE = {'type': 'command', 'command': (
    "sh -c '[ -f \"$HOME/.luady/hooks/luady_statusline.py\" ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; "
    "exec python3 \"$HOME/.luady/hooks/luady_statusline.py\"'")}
EARLY_KIT2_STEP = 'python3 "$HOME/.luady/hooks/luady_step.py"'  # what an early kit 2 registered
EARLY_KIT2_PAUSE = 'sh "$HOME/.luady/hooks/luady_pause.sh"'
OLD_TABLE = {
    ('SessionStart', None, LUADY_COMMAND): {'timeout': 5}, ('UserPromptSubmit', None, LUADY_COMMAND): {'async': True},
    ('Stop', None, LUADY_COMMAND): {'async': True}, ('StopFailure', None, LUADY_COMMAND): {'async': True},
    ('Notification', None, LUADY_COMMAND): {'async': True}, ('SessionEnd', None, LUADY_COMMAND): {'async': True},
    ('PreToolUse', 'AskUserQuestion', LUADY_COMMAND): {'timeout': 86460},
    ('PermissionRequest', None, LUADY_COMMAND): {'timeout': 86460}}
STEP_TABLE = {
    ('PreToolUse', '*', STEP_COMMAND): {'async': True}, ('PostToolUse', '*', STEP_COMMAND): {'async': True},
    ('PostToolUseFailure', '*', STEP_COMMAND): {'async': True}, ('SubagentStart', None, STEP_COMMAND): {'async': True},
    ('SubagentStop', None, STEP_COMMAND): {'async': True}}
PAUSE_ROW = {('PostToolUse', None, PAUSE_COMMAND): {'timeout': 5}}
FAILURE_PAUSE_ROW = {('PostToolUseFailure', None, PAUSE_COMMAND): {'timeout': 5}}  # the pause entry an earlier kit 2 put on the failure event
HOOK_FILES = ('luady_hook.py', 'luady_step.py', 'luady_statusline.py', 'luady_pause.sh')
KIT1_SETTINGS = {**FOREIGN, 'hooks': {
    **FOREIGN['hooks'],
    'SessionStart': [{'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'timeout': 5}]}],
    'Stop': [{'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'async': True}]}],
    'StopFailure': [{'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'async': True}]}],
    'Notification': [{'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'async': True}]}],
    'SessionEnd': [{'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'async': True}]}],
    'PermissionRequest': [{'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'timeout': 86460}]}]}}
KIT1_SETTINGS['hooks']['UserPromptSubmit'] = [*FOREIGN['hooks']['UserPromptSubmit'],
                                              {'hooks': [{'type': 'command', 'command': KIT1_COMMAND, 'async': True}]}]
KIT1_SETTINGS['hooks']['PreToolUse'] = [*FOREIGN['hooks']['PreToolUse'], {'matcher': 'AskUserQuestion', 'hooks': [
    {'type': 'command', 'command': KIT1_COMMAND, 'timeout': 86460}]}]


def luady_handlers(settings):
    return [(event, group.get('matcher'), handler) for event, groups in settings.get('hooks', {}).items()
            for group in groups for handler in group['hooks'] if '/.luady/hooks/luady_hook.py' in handler['command']]


def kit_table(settings):
    """{(event, matcher, command): options} of every kit handler; fails on a duplicate."""
    table = {}
    for event, groups in settings.get('hooks', {}).items():
        for group in groups:
            for handler in group['hooks']:
                if '/.luady/hooks/luady_' not in handler['command']:
                    continue
                key = (event, group.get('matcher'), handler['command'])
                assert key not in table, f'duplicate kit handler {key}'
                assert handler['type'] == 'command'
                table[key] = {k: v for k, v in handler.items() if k not in ('type', 'command')}
    return table


class InstallTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='luadyinstall-', ignore_cleanup_errors=True)
        self.home = Path(self._tmp.name)
        self.paths = common.KitPaths(self.home)
        (self.home / '.claude').mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def write_settings(self, data):
        self.paths.claude_settings.write_text(json.dumps(data), encoding='utf-8')

    def settings(self):
        return json.loads(self.paths.claude_settings.read_text(encoding='utf-8'))

    def run_main(self, *argv, src=KIT_ROOT):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = install.main(list(argv), now=NOW, src=src)
        return code, out.getvalue(), err.getvalue()

    def test_install_creates_layout_and_config(self):
        self.write_settings(FOREIGN)
        code, out, _ = self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        self.assertEqual(code, 0)
        result = json.loads(out)
        self.assertEqual((result['ok'], result['version'], result['host_alias']), (True, __version__, 'cedar'))
        for name in ('__init__.py', 'common.py', 'hook.py', 'ctl.py', 'tmuxio.py', 'transcripts.py', 'projects.py',
                     'sysinfo.py', 'ops.py', 'install.py'):
            self.assertTrue((self.paths.lib / 'luady_kit' / name).is_file(), name)
        self.assertTrue(os.access(self.paths.bin / 'luady-ctl', os.X_OK))
        self.assertTrue(os.access(self.paths.bin / 'luady-report', os.X_OK))
        self.assertTrue((self.paths.hooks / 'luady_hook.py').is_file())
        for name in common.RUNTIME_DIRS:
            self.assertTrue((self.paths.root / name).is_dir(), name)
        self.assertEqual(common.read_json_or_none(self.paths.config_file),
                         {'remote_answering': True, 'hook_wait_seconds': 14400, 'host_alias': 'cedar'})

    def test_merge_preserves_foreign_hooks_and_adds_c2_entries(self):
        self.write_settings(FOREIGN)
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        settings = self.settings()
        self.assertEqual((settings['model'], settings['remoteControlAtStartup']), ('opus', True))
        self.assertEqual(settings['hooks']['UserPromptSubmit'][0], FOREIGN['hooks']['UserPromptSubmit'][0])
        self.assertEqual(settings['hooks']['PreToolUse'][0], FOREIGN['hooks']['PreToolUse'][0])
        found = {(event, matcher): {k: v for k, v in handler.items() if k not in ('type', 'command')}
                 for event, matcher, handler in luady_handlers(settings)}
        self.assertEqual(found, {
            ('SessionStart', None): {'timeout': 5}, ('UserPromptSubmit', None): {'async': True},
            ('Stop', None): {'async': True}, ('StopFailure', None): {'async': True},
            ('Notification', None): {'async': True}, ('SessionEnd', None): {'async': True},
            ('PreToolUse', 'AskUserQuestion'): {'timeout': 86460}, ('PermissionRequest', None): {'timeout': 86460}})
        self.assertTrue(all(h['type'] == 'command' and h['command'] == LUADY_COMMAND
                            for _, _, h in luady_handlers(settings)))

    def test_install_is_idempotent_and_keeps_config_values(self):
        self.write_settings(FOREIGN)
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        common.atomic_write_json(self.paths.config_file,
                                 {'remote_answering': False, 'hook_wait_seconds': 600, 'host_alias': 'cedar'})
        first = self.settings()
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        self.assertEqual(self.settings(), first)
        self.assertEqual(len(luady_handlers(self.settings())), 8)
        self.assertEqual(common.read_json_or_none(self.paths.config_file),
                         {'remote_answering': False, 'hook_wait_seconds': 600, 'host_alias': 'cedar'})

    def test_backup_holds_the_original_settings(self):
        self.write_settings(FOREIGN)
        _, out, _ = self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        backup = Path(json.loads(out)['backup'])
        self.assertEqual(backup.parent, self.paths.backup)
        self.assertEqual(json.loads(backup.read_text(encoding='utf-8')), FOREIGN)
        _, out, _ = self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        self.assertNotEqual(Path(json.loads(out)['backup']), backup)
        self.assertEqual(json.loads(backup.read_text(encoding='utf-8')), FOREIGN)

    def test_install_without_existing_settings_creates_them(self):
        code, out, _ = self.run_main('--host-alias', 'birch', '--home', str(self.home))
        self.assertEqual(code, 0)
        self.assertIsNone(json.loads(out)['backup'])
        self.assertEqual(len(luady_handlers(self.settings())), 8)
        self.assertEqual(stat.S_IMODE(self.paths.claude_settings.stat().st_mode), 0o600)

    def test_uninstall_removes_only_luady_entries_and_code(self):
        self.write_settings(FOREIGN)
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        common.append_event(self.paths, common.build_record('stop', 'cedar', {}, {}, NOW))
        code, out, _ = self.run_main('--uninstall', '--home', str(self.home))
        self.assertEqual(code, 0)
        self.assertEqual(self.settings(), FOREIGN)
        for name in ('lib', 'bin'):
            self.assertFalse((self.paths.root / name).exists(), name)
        stub = self.paths.hooks / 'luady_hook.py'
        self.assertTrue(stub.exists(), 'uninstall must leave a no-op hook stub')
        ran = subprocess.run([sys.executable, str(stub)], input=b'{"hook_event_name":"UserPromptSubmit"}',
                             capture_output=True, timeout=10)
        self.assertEqual((ran.returncode, ran.stdout), (0, b''))
        self.assertTrue((self.paths.spool / 'events-20261009.jsonl').exists())
        self.assertEqual(json.loads(out)['kept'], str(self.paths.root))

    def test_skip_settings_installs_code_without_touching_settings(self):
        self.write_settings(FOREIGN)
        code, out, _ = self.run_main('--host-alias', 'hq', '--skip-settings', '--home', str(self.home))
        self.assertEqual(code, 0)
        self.assertEqual(self.settings(), FOREIGN)
        self.assertTrue((self.paths.hooks / 'luady_hook.py').exists())
        self.assertIsNone(json.loads(out)['settings'])

    def test_uninstall_drops_an_emptied_hooks_object(self):
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        self.run_main('--uninstall', '--home', str(self.home))
        self.assertEqual(self.settings(), {})

    def test_invalid_settings_abort_without_changes(self):
        self.paths.claude_settings.write_text('{broken', encoding='utf-8')
        code, _, err = self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        self.assertEqual(code, 1)
        self.assertIn('not valid JSON', err)
        self.assertEqual(self.paths.claude_settings.read_text(encoding='utf-8'), '{broken')
        self.assertFalse(self.paths.lib.exists())
        self.write_settings({'hooks': []})
        self.assertEqual(self.run_main('--host-alias', 'cedar', '--home', str(self.home))[0], 1)
        self.assertFalse(self.paths.lib.exists())

    def test_cli_argument_errors(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            install.main(['--home', str(self.home)])
        self.assertEqual(self.run_main('--host-alias', 'bad alias', '--home', str(self.home))[0], 1)
        self.assertEqual(self.run_main('--host-alias', 'cedar', '--home', str(self.home / 'missing'))[0], 1)

    def test_installed_shims_run_from_the_installed_lib(self):
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        env = {**os.environ, 'HOME': str(self.home)}
        ctl = subprocess.run([str(self.paths.bin / 'luady-ctl'), 'config', '--get'], env=env, capture_output=True,
                             text=True)
        self.assertEqual(ctl.returncode, 0, ctl.stderr)
        self.assertEqual(json.loads(ctl.stdout)['host_alias'], 'cedar')
        outside_tmux = {key: value for key, value in env.items() if key != 'TMUX_PANE'}
        report = subprocess.run([str(self.paths.bin / 'luady-report'), 'ready'], env=outside_tmux, capture_output=True,
                                text=True)
        self.assertEqual(report.returncode, 3, report.stderr)
        broken =subprocess.run([sys.executable, str(self.paths.hooks / 'luady_hook.py')], input=b'not json', env=env,
                                capture_output=True)
        self.assertEqual((broken.returncode, broken.stdout), (0, b''))
        self.assertIn('hook failed', self.paths.hook_errors.read_text(encoding='utf-8'))
        stop = json.dumps({'hook_event_name': 'Stop', 'session_id': 's1', 'last_assistant_message': 'hi'}).encode()
        subprocess.run([sys.executable, str(self.paths.hooks / 'luady_hook.py')], input=stop, env=env, check=True)
        self.assertEqual(read_spool(self.paths)[-1]['data'], {'last_assistant_message': 'hi', 'truncated': False})

    def test_hook_shim_exits_zero_even_without_the_kit(self):
        broken = self.home / 'broken'
        (broken / 'hooks').mkdir(parents=True)
        shutil.copy(KIT_ROOT / 'hooks' / 'luady_hook.py', broken / 'hooks' / 'luady_hook.py')
        result = subprocess.run([sys.executable, '-I', str(broken / 'hooks' / 'luady_hook.py')], input=b'{}',
                                env={**os.environ, 'HOME': str(self.home)}, capture_output=True)
        self.assertEqual((result.returncode, result.stdout), (0, b''))
        self.assertIn('shim:', self.paths.hook_errors.read_text(encoding='utf-8'))

    def fake_claude(self, version):
        self.paths.claude_bin.parent.mkdir(parents=True, exist_ok=True)
        self.paths.claude_bin.write_text(f'#!/bin/sh\necho "{version} (Claude Code)"\n', encoding='ascii')
        self.paths.claude_bin.chmod(0o755)

    def install_summary(self, *extra):
        code, out, err = self.run_main('--host-alias', 'cedar', '--home', str(self.home), *extra)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_kit2_handler_table_on_a_verified_claude(self):
        self.fake_claude('2.1.295')
        self.write_settings(FOREIGN)
        summary = self.install_summary()
        self.assertEqual(kit_table(self.settings()), {**OLD_TABLE, **STEP_TABLE, **PAUSE_ROW})
        self.assertEqual(len(kit_table(self.settings())), 14)
        self.assertEqual((summary['steps'], summary['statusline'], summary['version']), ('on', 'installed', '2.1.0'))
        self.assertEqual(self.settings()['statusLine'], STATUSLINE)

    def test_step_hooks_stay_off_on_an_old_or_unknown_claude(self):
        for version in ('2.1.200', None):
            with self.subTest(version=version):
                self.paths.claude_bin.unlink(missing_ok=True)
                if version:
                    self.fake_claude(version)
                self.write_settings(FOREIGN)
                summary = self.install_summary()
                self.assertEqual(kit_table(self.settings()), {**OLD_TABLE, **PAUSE_ROW})
                self.assertTrue(summary['steps'].startswith('off:'), summary['steps'])
                self.assertIn(version or 'unknown', summary['steps'])

    def test_no_steps_flag_on_a_new_claude(self):
        self.fake_claude('2.1.325')
        summary = self.install_summary('--no-steps')
        self.assertEqual(kit_table(self.settings()), {**OLD_TABLE, **PAUSE_ROW})
        self.assertTrue(summary['steps'].startswith('off:'))

    def test_kit2_install_keeps_foreign_hooks_first_and_is_idempotent(self):
        self.fake_claude('2.1.325')
        self.write_settings(FOREIGN)
        self.install_summary()
        first = self.settings()
        self.assertEqual(first['hooks']['UserPromptSubmit'][0], FOREIGN['hooks']['UserPromptSubmit'][0])
        self.assertEqual(first['hooks']['PreToolUse'][0], FOREIGN['hooks']['PreToolUse'][0])
        self.assertEqual(self.install_summary()['statusline'], 'kept')
        self.assertEqual(self.settings(), first)

    def test_upgrade_from_kit1_settings_keeps_one_copy_of_each_entry(self):
        self.fake_claude('2.1.325')
        self.write_settings(KIT1_SETTINGS)
        self.install_summary()
        self.assertEqual(kit_table(self.settings()), {**OLD_TABLE, **STEP_TABLE, **PAUSE_ROW})
        self.assertEqual(self.settings()['hooks']['UserPromptSubmit'][0], FOREIGN['hooks']['UserPromptSubmit'][0])
        self.run_main('--uninstall', '--home', str(self.home))
        self.assertEqual(self.settings(), FOREIGN)

    def test_reinstall_removes_the_pause_check_an_earlier_kit2_put_on_the_failure_event(self):
        self.fake_claude('2.1.325')
        earlier = {**FOREIGN, 'hooks': {**FOREIGN['hooks'], 'PostToolUseFailure': [
            {'matcher': '*', 'hooks': [{'type': 'command', 'command': EARLY_KIT2_STEP, 'async': True}]},
            {'hooks': [{'type': 'command', 'command': EARLY_KIT2_PAUSE, 'timeout': 5}]}]}}
        self.write_settings(earlier)
        self.install_summary()
        failure = self.settings()['hooks']['PostToolUseFailure']
        self.assertEqual([h['command'] for g in failure for h in g['hooks']], [STEP_COMMAND])
        self.assertNotIn(('PostToolUseFailure', None, PAUSE_COMMAND), kit_table(self.settings()))

    def test_a_settings_change_made_during_the_install_is_kept(self):
        self.fake_claude('2.1.325')
        self.write_settings(FOREIGN)
        real_copy = install.copy_kit

        def copy_and_meanwhile_edit(src, paths):
            real_copy(src, paths)
            changed = json.loads(paths.claude_settings.read_text(encoding='utf-8'))
            changed['theme'] = 'light'  # e.g. the owner runs /config in a session while the kit installs
            paths.claude_settings.write_text(json.dumps(changed), encoding='utf-8')

        with mock.patch.object(install, 'copy_kit', copy_and_meanwhile_edit), \
                mock.patch.object(install.os, 'replace', wraps=os.replace) as replaced:
            summary = self.install_summary()
        self.assertEqual(self.settings()['theme'], 'light')
        self.assertEqual(len(kit_table(self.settings())), 14)
        target = Path(os.path.realpath(self.paths.claude_settings))
        self.assertTrue(any(Path(call.args[1]) == target and Path(call.args[0]).parent == target.parent
                            for call in replaced.call_args_list))
        self.assertEqual([p.name for p in target.parent.iterdir() if p.name.endswith('.tmp')], [])
        self.assertIn('theme', json.loads(Path(summary['backup']).read_text(encoding='utf-8')))
        self.run_main('--uninstall', '--home', str(self.home))
        self.assertEqual(self.settings(), {**FOREIGN, 'theme': 'light'})

    def test_an_existing_command_status_line_is_wrapped_and_restored(self):
        original = {'type': 'command', 'command': 'sl.sh', 'padding': 0}
        self.write_settings({**FOREIGN, 'statusLine': original, 'theme': 'dark'})
        self.assertEqual(self.install_summary()['statusline'], 'wrapped')
        settings = self.settings()
        self.assertEqual(settings['statusLine'], {**STATUSLINE, 'padding': 0})
        self.assertEqual(list(settings)[-2:], ['statusLine', 'theme'])
        self.assertEqual(self.paths.statusline_chain.read_bytes(), common.dumps_pretty(original))
        self.assertEqual(self.install_summary()['statusline'], 'kept')
        self.assertEqual(common.read_json_or_none(self.paths.statusline_chain), original)
        self.run_main('--uninstall', '--home', str(self.home))
        restored = self.settings()
        self.assertEqual(restored, {**FOREIGN, 'statusLine': original, 'theme': 'dark'})
        self.assertEqual(json.dumps(restored['statusLine']), json.dumps(original))
        self.assertEqual(list(restored), ['model', 'remoteControlAtStartup', 'hooks', 'statusLine', 'theme'])
        self.assertFalse(self.paths.statusline_chain.exists())

    def test_a_status_line_of_another_type_is_left_alone(self):
        other = {'type': 'static', 'text': 'hi'}
        self.write_settings({**FOREIGN, 'statusLine': other})
        summary = self.install_summary()
        self.assertEqual(summary['statusline'], 'skipped: the existing statusLine is not a command')
        self.assertEqual(self.settings()['statusLine'], other)
        self.assertFalse(self.paths.statusline_chain.exists())
        self.run_main('--uninstall', '--home', str(self.home))
        self.assertEqual(self.settings(), {**FOREIGN, 'statusLine': other})

    def test_uninstall_leaves_exit_zero_stubs_for_every_hook_file(self):
        self.fake_claude('2.1.325')
        self.write_settings(FOREIGN)
        self.install_summary()
        for name in HOOK_FILES:
            self.assertTrue(os.access(self.paths.hooks / name, os.X_OK), name)
        self.run_main('--uninstall', '--home', str(self.home))
        self.assertEqual(self.settings(), FOREIGN)
        for name in HOOK_FILES:
            stub = self.paths.hooks / name
            argv = ['sh', str(stub)] if name.endswith('.sh') else [sys.executable, str(stub)]
            ran = subprocess.run(argv, input=b'{"hook_event_name":"PostToolUse"}', capture_output=True, timeout=10,
                                 env={**os.environ, 'HOME': str(self.home), 'TMUX_PANE': '%1', 'TMUX': '/t,1,0'})
            self.assertEqual((ran.returncode, ran.stdout), (0, b''), name)

    def test_skip_settings_copies_every_hook_file_and_writes_no_settings(self):
        self.fake_claude('2.1.325')
        summary = self.install_summary('--skip-settings')
        self.assertFalse(self.paths.claude_settings.exists())
        for name in HOOK_FILES:
            self.assertTrue((self.paths.hooks / name).is_file(), name)
        self.assertTrue(summary['steps'].startswith('off:'))
        self.assertTrue(summary['statusline'].startswith('skipped:'))

    def installed_kit_version(self):
        ctl = subprocess.run([str(self.paths.bin / 'luady-ctl'), 'version'], env={**os.environ, 'HOME': str(self.home)},
                             capture_output=True, text=True)
        return json.loads(ctl.stdout)['kit']

    def test_version_two_one(self):
        self.assertEqual(__version__, '2.1.0')
        self.run_main('--host-alias', 'cedar', '--home', str(self.home))
        self.assertEqual(self.installed_kit_version(), '2.1.0')

    def test_upgrade_from_kit_2_0_0_keeps_the_hook_table_and_adds_the_new_verbs(self):
        self.fake_claude('2.1.325')
        self.write_settings(FOREIGN)
        old = Path(self._tmp.name) / 'kit-2.0.0'
        shutil.copytree(KIT_ROOT, old, ignore=shutil.ignore_patterns('tests', 'spikes', '__pycache__'))
        for name in ('skills.py', 'kb.py', 'gitstatus.py'):
            (old / 'luady_kit' / name).unlink()
        init = old / 'luady_kit' / '__init__.py'
        init.write_text(init.read_text(encoding='utf-8').replace("'2.1.0'", "'2.0.0'"), encoding='utf-8')
        self.assertEqual(self.run_main('--host-alias', 'cedar', '--home', str(self.home), src=old)[0], 0)
        self.assertEqual(self.installed_kit_version(), '2.0.0')
        before = self.settings()
        summary = self.install_summary()
        self.assertEqual(summary['version'], '2.1.0')
        self.assertEqual(self.settings(), before)
        self.assertEqual(kit_table(self.settings()), {**OLD_TABLE, **STEP_TABLE, **PAUSE_ROW})
        self.assertEqual(self.installed_kit_version(), '2.1.0')
        for name in ('skills.py', 'kb.py', 'gitstatus.py'):
            self.assertTrue((self.paths.lib / 'luady_kit' / name).is_file(), name)
        ran = subprocess.run([str(self.paths.bin / 'luady-ctl'), 'skills'], env={**os.environ, 'HOME': str(self.home)},
                             capture_output=True, text=True)
        self.assertEqual((ran.returncode, json.loads(ran.stdout)), (0, {'skills': []}))

    def test_upgrade_from_a_real_kit_1_0_0_install(self):
        self.fake_claude('2.1.325')
        self.write_settings(FOREIGN)
        kit1 = KIT_ROOT / 'tests' / 'fixtures' / 'kit1'
        ran = subprocess.run([sys.executable, str(kit1 / 'install.py'), '--host-alias', 'cedar', '--home', str(self.home)],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(self.installed_kit_version(), '1.0.0')
        self.assertEqual(self.install_summary()['version'], '2.1.0')
        self.assertEqual(kit_table(self.settings()), {**OLD_TABLE, **STEP_TABLE, **PAUSE_ROW})
        self.assertEqual(self.installed_kit_version(), '2.1.0')
        self.assertEqual(common.load_config(self.paths)['host_alias'], 'cedar')

    def test_claude_version_parsing(self):
        self.assertIsNone(install.claude_version(self.paths))
        self.fake_claude('2.1.323')
        self.assertEqual(install.claude_version(self.paths), (2, 1, 323))
        self.assertTrue(install.steps_supported((2, 1, 295)))
        self.assertFalse(install.steps_supported((2, 1, 294)))
        self.assertFalse(install.steps_supported(None))

    def test_crlf_sources_are_normalized(self):
        src = self.home / 'src'
        shutil.copytree(KIT_ROOT / 'luady_kit', src / 'luady_kit')
        (src / 'bin').mkdir()
        (src / 'hooks').mkdir()
        (src / 'bin' / 'luady-ctl').write_bytes((KIT_ROOT / 'bin' / 'luady-ctl').read_bytes().replace(b'\n', b'\r\n'))
        shutil.copy(KIT_ROOT / 'hooks' / 'luady_hook.py', src / 'hooks' / 'luady_hook.py')
        self.assertEqual(self.run_main('--host-alias', 'cedar', '--home', str(self.home), src=src)[0], 0)
        self.assertNotIn(b'\r', (self.paths.bin / 'luady-ctl').read_bytes())


if __name__ == '__main__':
    unittest.main()
