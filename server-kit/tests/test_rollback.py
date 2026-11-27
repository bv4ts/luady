"""No state of the kit may stop a Claude Code session from running a tool call.

Kit 2 is installed for real (with a chained status line and a leftover pause flag for the pane), then one of the
rollbacks below is applied, and every command still registered in ~/.claude/settings.json is run the way Claude Code
runs it (`sh -c <command>`, the hook JSON on stdin). Each must exit 0 and print nothing a session could read as an
instruction: no stop line, no decision; the status line may only print the owner's own line or an empty line.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

from luady_kit import common, install

KIT_ROOT = Path(__file__).resolve().parent.parent
KIT1 = KIT_ROOT / 'tests' / 'fixtures' / 'kit1'  # server-kit as of kit 1.0.0
NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)
FOREIGN_STATUS = {'type': 'command', 'command': 'printf owner-line'}
SETTINGS = {'model': 'opus', 'statusLine': FOREIGN_STATUS, 'hooks': {
    'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'true'}]}]}}  # a shell built-in
SERVER_PID, PANE = '4242', '%7'
PAYLOAD = {'session_id': 'sess-1', 'transcript_path': '/t.jsonl', 'cwd': '/w', 'permission_mode': 'default',
           'tool_name': 'Bash', 'tool_input': {'command': 'ls'}, 'tool_response': {}, 'tool_use_id': 'toolu_1',
           'prompt': 'hi', 'source': 'startup', 'last_assistant_message': 'done', 'agent_id': 'a1', 'agent_type': 'X'}


class RollbackTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='luadyrollback-', ignore_cleanup_errors=True)
        self.home = Path(self._tmp.name)
        self.paths = common.KitPaths(self.home)
        (self.home / '.claude').mkdir()
        self.paths.claude_settings.write_text(json.dumps(SETTINGS), encoding='utf-8')
        self.paths.claude_bin.parent.mkdir(parents=True)
        self.paths.claude_bin.write_text('#!/bin/sh\necho "2.1.325 (Claude Code)"\n', encoding='ascii')
        self.paths.claude_bin.chmod(0o755)
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(install.main(['--host-alias', 'cedar', '--home', str(self.home)], now=NOW, src=KIT_ROOT), 0)
        self.assertEqual(json.loads(out.getvalue())['steps'], 'on')
        common.atomic_write_json(self.paths.config_file, {**common.default_config('cedar'), 'remote_answering': False})
        common.atomic_write_json(self.paths.pause / f'{SERVER_PID}-{PANE[1:]}',
                                 {'target': 'cc-app:0.0', 'at': '2026-11-14T11:00:00.000Z', 'hit': False})

    def tearDown(self):
        self._tmp.cleanup()

    def env(self, **changes):
        base = {'HOME': str(self.home), 'PATH': os.environ['PATH'], 'TMUX': f'/tmp/tmux-1/default,{SERVER_PID},0',
                'TMUX_PANE': PANE, 'LANG': 'C.UTF-8'}
        merged = {**base, **changes}
        return {key: value for key, value in merged.items() if value is not None}

    def registered(self):
        settings = json.loads(self.paths.claude_settings.read_text(encoding='utf-8'))
        commands = [(event, handler['command']) for event, groups in settings.get('hooks', {}).items()
                    for group in groups for handler in group['hooks']]
        line = settings.get('statusLine')
        return commands, (line['command'] if isinstance(line, dict) else None)

    def run_kit1(self, *argv):
        result = subprocess.run(['python3', str(KIT1 / 'install.py'), *argv, '--home', str(self.home)],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_every_session_can_run_a_tool_call(self, env):
        commands, status_line = self.registered()
        self.assertTrue(commands)
        for event, command in commands:
            payload = json.dumps({**PAYLOAD, 'hook_event_name': event}).encode('utf-8')
            ran = subprocess.run(['/bin/sh', '-c', command], input=payload, env=env, capture_output=True, timeout=60)
            self.assertEqual((ran.returncode, ran.stdout), (0, b''), f'{event}: {command}\n{ran.stderr!r}')
        if status_line is not None:
            ran = subprocess.run(['/bin/sh', '-c', status_line], input=b'{"session_id": "sess-1"}', env=env,
                                 capture_output=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)
            self.assertIn(ran.stdout, (b'', b'\n', b'owner-line'), status_line)

    def test_the_intact_kit_still_pauses_this_pane(self):
        """The control case: with the kit in place the leftover flag does stop the pane, so the checks below matter."""
        _, command = next(item for item in self.registered()[0] if 'luady_pause.sh' in item[1])
        ran = subprocess.run(['/bin/sh', '-c', command], input=b'{}', env=self.env(), capture_output=True, timeout=60)
        self.assertIn(b'"continue": false', ran.stdout)

    def test_kit_folder_deleted_while_the_entries_are_registered(self):
        shutil.rmtree(self.paths.root)
        self.assert_every_session_can_run_a_tool_call(self.env())

    def test_only_the_lib_folder_deleted(self):
        shutil.rmtree(self.paths.lib)
        self.assert_every_session_can_run_a_tool_call(self.env())
        _, status_line = self.registered()
        ran = subprocess.run(['/bin/sh', '-c', status_line], input=b'{}', env=self.env(), capture_output=True)
        self.assertEqual(ran.stdout, b'owner-line')
        log = self.paths.hook_errors.read_text(encoding='utf-8') if self.paths.hook_errors.exists() else ''
        self.assertNotIn('step shim', log)
        self.assertNotIn('status line shim', log)

    def test_kit1_install_run_over_kit2(self):
        self.run_kit1('--host-alias', 'cedar')
        self.assertIn('luady_step.py', json.dumps(self.registered()))  # kit 1 leaves the kit-2 entries behind
        self.assert_every_session_can_run_a_tool_call(self.env())

    def test_kit1_uninstall_run_over_kit2(self):
        self.run_kit1('--uninstall')
        self.assertIn('luady_pause.sh', json.dumps(self.registered()))
        self.assert_every_session_can_run_a_tool_call(self.env())

    def test_home_unset(self):
        self.assert_every_session_can_run_a_tool_call(self.env(HOME=None))

    def test_python3_missing_from_path(self):
        only_sh = self.home / 'only-sh'
        only_sh.mkdir()
        (only_sh / 'sh').symlink_to(shutil.which('sh'))
        self.assert_every_session_can_run_a_tool_call(self.env(PATH=str(only_sh)))


if __name__ == '__main__':
    unittest.main()
