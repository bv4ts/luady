"""The asynchronous step hook: one spool line per step or helper event, tmux from the registry, never breaks."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

from luady_kit import common, hook, steps
from luady_kit.common import RunResult
from luady_kit.tmuxio import Tmux
from tests.helpers import HomeTestCase

KIT_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = KIT_ROOT / 'tests' / 'fixtures' / 's3'
NOW = datetime(2026, 11, 14, 9, 30, 0, tzinfo=timezone.utc)
ENVELOPE = {'v', 'id', 'ts', 'host', 'event', 'session_id', 'cwd', 'transcript_path', 'tmux', 'permission_mode', 'data'}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))


class StepHookTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='cedar')
        self.tmux_calls = []

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            self.tmux_calls.append(argv)
            return RunResult(0, b'cc-pane:0.1\t999', b'')
        self.tmux = Tmux(run)

    def env(self, environ=None):
        return hook.HookEnv(paths=self.paths, tmux=self.tmux, now=lambda: NOW,
                            environ={'TMUX_PANE': '%3'} if environ is None else environ)

    def register(self, sid='SESSION_ID', target='cc-app:0.0'):
        common.write_registry(self.paths, {'session_id': sid, 'tmux': target, 'started_at': 'x'})

    def run_step(self, payload, environ=None):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        self.assertEqual(steps.main(stdin=io.BytesIO(raw), env=self.env(environ)), 0)
        return self.spool_events()

    def test_tool_start_takes_the_live_pane_target_and_corrects_the_registry(self):
        self.register()  # SessionStart saw cc-app:0.0; the pane is cc-pane:0.1 now
        events = self.run_step(fixture('PreToolUse-Bash'), environ={'TMUX_PANE': '%3', 'TMUX': '/tmp/t,555,0'})
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual((event['event'], event['tmux'], event['host'], event['session_id']),
                         ('tool_start', 'cc-pane:0.1', 'cedar', 'SESSION_ID'))
        self.assertEqual(event['data']['title'], 'echo ok')
        self.assertEqual(set(event), ENVELOPE)
        self.assertEqual(len(self.tmux_calls), 1)
        entry = common.read_registry(self.paths, 'SESSION_ID')
        self.assertEqual((entry['tmux'], entry['pane_id'], entry['server_pid'], entry['pane_pid']),
                         ('cc-pane:0.1', '%3', '555', 999))
        before = self.paths.registry.joinpath('SESSION_ID.json').stat().st_mtime_ns
        self.run_step(fixture('PreToolUse-Bash'), environ={'TMUX_PANE': '%3', 'TMUX': '/tmp/t,555,0'})
        self.assertEqual(self.paths.registry.joinpath('SESSION_ID.json').stat().st_mtime_ns, before)

    def test_tool_end_and_failure(self):
        self.register()
        self.run_step(fixture('PostToolUse-Bash'))
        self.run_step(fixture('PostToolUseFailure-Bash'))
        ends = [(e['event'], e['data']['ok']) for e in self.spool_events()]
        self.assertEqual(ends, [('tool_end', True), ('tool_end', False)])

    def test_helper_ids_and_helper_events(self):
        self.register()
        self.run_step(fixture('PostToolUse-Bash-in-subagent'))
        self.run_step(fixture('SubagentStart'))
        self.run_step(fixture('SubagentStop'))
        events = self.spool_events()
        self.assertEqual([e['event'] for e in events], ['tool_end', 'subagent_start', 'subagent_stop'])
        self.assertEqual((events[0]['data']['agent_id'], events[0]['data']['agent_type']), ('AGENT_ID', 'Explore'))
        self.assertEqual(events[2]['data'], {'agent_id': 'AGENT_ID', 'agent_type': 'Explore'})

    def test_a_helper_stop_without_a_known_start_is_ignored(self):
        self.register()
        self.run_step(fixture('SubagentStop'))
        self.run_step(fixture('SubagentStop-prompt-suggestion'))
        self.assertEqual(self.spool_events(), [])
        self.run_step(fixture('SubagentStart'))
        self.run_step(fixture('SubagentStop'))
        self.run_step(fixture('SubagentStop'))
        self.assertEqual([e['event'] for e in self.spool_events()], ['subagent_start', 'subagent_stop'])

    def test_hourly_cleanup_drops_markers_of_helpers_that_never_stopped(self):
        stale = steps.helper_marker(self.paths, 'SESSION_ID', 'old')
        fresh = steps.helper_marker(self.paths, 'SESSION_ID', 'new')
        stale.parent.mkdir(parents=True)
        for path, age in ((stale, 3 * 86400), (fresh, 60)):
            path.touch()
            os.utime(path, (NOW.timestamp() - age, NOW.timestamp() - age))
        hook.run_cleanup(self.env(), common.load_config(self.paths))
        self.assertEqual((stale.exists(), fresh.exists()), (False, True))

    def test_unregistered_session_asks_tmux_once(self):
        events = self.run_step(fixture('PreToolUse-Bash'))
        self.assertEqual(events[0]['tmux'], 'cc-pane:0.1')
        self.assertEqual(self.tmux_calls, [['tmux', 'display-message', '-p', '-t', '%3', '#S:#I.#P\t#{pane_pid}']])

    def test_outside_tmux_the_tmux_field_is_null(self):
        events = self.run_step(fixture('PreToolUse-Bash'), environ={})
        self.assertIsNone(events[0]['tmux'])
        self.assertEqual(self.tmux_calls, [])

    def test_ask_user_question_and_other_events_write_nothing(self):
        self.run_step({**fixture('PreToolUse-Bash'), 'tool_name': 'AskUserQuestion'})
        self.run_step(fixture('Stop'))
        self.assertEqual(self.spool_events(), [])

    def test_bad_input_is_logged_and_never_breaks(self):
        self.assertEqual(self.run_step(b'not json'), [])
        self.assertEqual(self.run_step(b'[1]'), [])
        log = self.paths.hook_errors.read_text(encoding='utf-8')
        self.assertEqual(log.count('step hook failed'), 2)

    def test_spool_dir_replaced_by_a_file_still_returns_zero(self):
        self.paths.spool.rmdir()
        self.paths.spool.write_text('not a directory', encoding='utf-8')
        self.assertEqual(steps.main(stdin=io.BytesIO(json.dumps(fixture('PreToolUse-Bash')).encode()), env=self.env()), 0)
        self.assertIn('step hook failed', self.paths.hook_errors.read_text(encoding='utf-8'))

    def test_event_target_outside_tmux_is_none_even_for_a_registered_session(self):
        self.register('s-1', 'cc-a:1.2')
        self.assertIsNone(hook.event_target(self.env(environ={}), 's-1'))
        self.assertEqual(self.tmux_calls, [])
        for sid in ('s-3', '../x', None, 7):
            self.assertEqual(hook.event_target(self.env(), sid), 'cc-pane:0.1')
        self.assertEqual(hook.tmux_ids({'TMUX_PANE': '%9', 'TMUX': '/tmp/tmux-1/default,4242,0'}), ('%9', '4242'))
        self.assertEqual(hook.tmux_ids({'TMUX': 'garbage'}), (None, None))

    def test_shim_runs_from_the_source_tree(self):
        payload = json.dumps(fixture('PreToolUse-Bash')).encode('utf-8')
        env = {k: v for k, v in os.environ.items() if k != 'TMUX_PANE'}
        result = subprocess.run([sys.executable, str(KIT_ROOT / 'hooks' / 'luady_step.py')], input=payload,
                                env={**env, 'HOME': str(self.home)}, capture_output=True, timeout=20)
        self.assertEqual((result.returncode, result.stdout), (0, b''))
        self.assertEqual([e['event'] for e in self.spool_events()], ['tool_start'])
        broken = subprocess.run([sys.executable, str(KIT_ROOT / 'hooks' / 'luady_step.py')], input=b'{',
                                env={**env, 'HOME': str(self.home)}, capture_output=True, timeout=20)
        self.assertEqual((broken.returncode, broken.stdout), (0, b''))


if __name__ == '__main__':
    unittest.main()
