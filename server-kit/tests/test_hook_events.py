"""Hook event normalization, registry, never-break error handling and hourly cleanup."""
from __future__ import annotations

import io
import json
import os
import unittest
from datetime import datetime, timedelta, timezone

from luady_kit import common, hook
from luady_kit.common import RunResult
from luady_kit.tmuxio import Tmux
from tests.helpers import HomeTestCase

NOW = datetime(2026, 10, 9, 19, 42, 11, 123000, tzinfo=timezone.utc)
BASE = {'session_id': 'sess-1', 'transcript_path': '/home/dev/.claude/projects/-w/sess-1.jsonl',
        'cwd': '/home/dev/projects/app', 'permission_mode': 'bypassPermissions'}


def fake_tmux(output='cc-app:0.0\t4242', code=0):
    calls = []

    def run(argv, input_bytes=None, timeout=10.0, cwd=None):
        calls.append(argv)
        return RunResult(code, output.encode('utf-8'), b'')
    return Tmux(run), calls


class HookEventsTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='cedar')
        self.tmux, self.tmux_calls = fake_tmux()
        self.now = NOW

    def env(self, **overrides):
        base = {'paths': self.paths, 'tmux': self.tmux, 'environ': {'TMUX_PANE': '%7'}, 'now': lambda: self.now}
        return hook.HookEnv(**{**base, **overrides})

    def run_hook(self, payload, env=None):
        out = io.BytesIO()
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        code = hook.main(stdin=io.BytesIO(raw), stdout=out, env=env or self.env())
        return code, out.getvalue()

    def only_event(self):
        events = self.spool_events()
        self.assertEqual(len(events), 1, events)
        return events[0]

    def test_session_start_writes_registry_and_event(self):
        payload = {**BASE, 'hook_event_name': 'SessionStart', 'source': 'startup', 'model': 'claude-opus-4-1'}
        self.assertEqual(self.run_hook(payload), (0, b''))
        event = self.only_event()
        self.assertEqual((event['event'], event['data']), ('session_start', {'source': 'startup', 'model': 'claude-opus-4-1'}))
        self.assertEqual((event['host'], event['tmux'], event['session_id'], event['permission_mode']),
                         ('cedar', 'cc-app:0.0', 'sess-1', 'bypassPermissions'))
        self.assertEqual(event['ts'], '2026-10-09T19:42:11.123Z')
        self.assertEqual(common.read_registry(self.paths, 'sess-1'), {
            'session_id': 'sess-1', 'transcript_path': BASE['transcript_path'], 'cwd': BASE['cwd'],
            'tmux': 'cc-app:0.0', 'source': 'startup', 'started_at': '2026-10-09T19:42:11.123Z', 'pane_pid': 4242,
            'pane_id': '%7', 'server_pid': None})
        self.assertEqual(self.tmux_calls, [['tmux', 'display-message', '-p', '-t', '%7', '#S:#I.#P\t#{pane_pid}']])

    def test_session_start_model_object_or_missing(self):
        self.run_hook({**BASE, 'hook_event_name': 'SessionStart', 'source': 'clear',
                       'model': {'id': 'opus', 'display_name': 'Opus'}})
        self.run_hook({**BASE, 'session_id': 'sess-2', 'hook_event_name': 'SessionStart', 'source': 'resume'})
        self.assertEqual([e['data'] for e in self.spool_events()],
                         [{'source': 'clear', 'model': 'opus'}, {'source': 'resume', 'model': None}])

    def test_invalid_session_id_skips_registry_but_records_event(self):
        self.run_hook({**BASE, 'session_id': '../x', 'hook_event_name': 'SessionStart', 'source': 'startup'})
        self.assertEqual(common.list_registry(self.paths), [])
        self.assertEqual(self.only_event()['event'], 'session_start')
        self.assertIn('invalid session_id', self.paths.hook_errors.read_text(encoding='utf-8'))

    def test_prompt_hash_and_preview(self):
        prompt = '  مرحبا\r\n' + 'x' * 300
        self.run_hook({**BASE, 'hook_event_name': 'UserPromptSubmit', 'prompt': prompt})
        data = self.only_event()['data']
        self.assertEqual(data['prompt_sha256'], common.prompt_hash(prompt))
        self.assertEqual(len(data['prompt_preview']), 200)
        self.assertTrue(data['prompt_preview'].endswith('…'))

    def test_stop_truncates_last_assistant_message(self):
        self.run_hook({**BASE, 'hook_event_name': 'Stop', 'last_assistant_message': '\U0001f680' * 8001})
        data = self.only_event()['data']
        self.assertEqual((len(data['last_assistant_message']), data['truncated']), (8000, True))
        self.assertEqual(data['last_assistant_message'][-1], '…')

    def test_stop_without_message_and_short_message(self):
        self.run_hook({**BASE, 'hook_event_name': 'Stop'})
        self.run_hook({**BASE, 'hook_event_name': 'Stop', 'last_assistant_message': 'done'})
        self.assertEqual([e['data'] for e in self.spool_events()],
                         [{'last_assistant_message': '', 'truncated': False},
                          {'last_assistant_message': 'done', 'truncated': False}])

    def test_stop_failure_combines_error_fields(self):
        self.run_hook({**BASE, 'hook_event_name': 'StopFailure', 'error': 'rate_limit',
                       'error_details': '429 Too Many Requests', 'last_assistant_message': 'API Error: Rate limit reached'})
        self.assertEqual(self.only_event()['data'],
                         {'error': 'rate_limit — 429 Too Many Requests — API Error: Rate limit reached'})

    def test_notification_and_session_end(self):
        self.run_hook({**BASE, 'hook_event_name': 'Notification', 'notification_type': 'idle_prompt',
                       'message': 'm' * 1001})
        common.write_registry(self.paths, {'session_id': 'sess-1', 'tmux': 'cc-app:0.0', 'started_at': 'x'})
        self.run_hook({**BASE, 'hook_event_name': 'SessionEnd', 'reason': 'clear'})
        notification, end = self.spool_events()
        self.assertEqual(notification['data']['notification_type'], 'idle_prompt')
        self.assertEqual(len(notification['data']['message']), 1000)
        self.assertIsNone(notification['data']['title'])
        self.assertEqual(end['data'], {'reason': 'clear'})
        self.assertIsNone(common.read_registry(self.paths, 'sess-1'))

    def test_text_that_leaves_the_server_is_redacted(self):
        token = 'ghp_' + 'Q7x' * 12
        password = 'DB_PASSWORD=' + 'hunter2'
        header = 'Author' + 'ization: Bearer ' + token
        prompt = f'deploy with {password} and token {token}'
        self.run_hook({**BASE, 'hook_event_name': 'UserPromptSubmit', 'prompt': prompt})
        self.run_hook({**BASE, 'hook_event_name': 'Stop', 'last_assistant_message': f'I set {password} in .env'})
        self.run_hook({**BASE, 'hook_event_name': 'StopFailure', 'error': f'curl -H "{header}" failed'})
        self.run_hook({**BASE, 'hook_event_name': 'Notification', 'notification_type': 'permission_prompt',
                       'message': 'needs permission: mysql -pHunter2pass', 'title': f'token {token}'})
        raw = json.dumps(self.spool_events())
        for leaked in ('hunter2', token, 'Hunter2pass'):
            self.assertNotIn(leaked, raw)
        prompt_data, stop, failure, notification = [event['data'] for event in self.spool_events()]
        self.assertEqual(prompt_data, {'prompt_sha256': common.prompt_hash(prompt),
                                       'prompt_preview': 'deploy with DB_PASSWORD=[redacted] and token [redacted]'})
        self.assertEqual(stop, {'last_assistant_message': 'I set DB_PASSWORD=[redacted] in .env', 'truncated': False})
        self.assertEqual(failure, {'error': 'curl -H "Authorization: Bearer [redacted]" failed'})
        self.assertEqual((notification['message'], notification['title']),
                         ('needs permission: mysql -p[redacted]', 'token [redacted]'))

    def test_a_secret_across_the_cut_is_redacted_before_the_cut(self):
        token = 'ghp_' + 'Q7x' * 12
        self.run_hook({**BASE, 'hook_event_name': 'UserPromptSubmit', 'prompt': 'x ' * 90 + token + ' tail' * 10})
        preview = self.only_event()['data']['prompt_preview']
        self.assertEqual(len(preview), 200)
        self.assertNotIn('Q7x', preview)
        self.assertEqual(hook.redacted_clip('y' * 10_000, 50), ('y' * 49 + '…', True))

    def test_outside_tmux_the_tmux_field_is_null(self):
        self.run_hook({**BASE, 'hook_event_name': 'Stop'}, env=self.env(environ={}))
        self.assertIsNone(self.only_event()['tmux'])
        self.assertEqual(self.tmux_calls, [])

    def test_tool_events_are_ignored_by_the_question_hook(self):
        # luady_hook.py ignores PostToolUse on purpose: tool steps go to the separate hooks/luady_step.py.
        self.assertEqual(self.run_hook({**BASE, 'hook_event_name': 'PostToolUse'}), (0, b''))
        self.assertEqual(self.spool_events(), [])

    def test_never_breaks_on_bad_input_or_io_errors(self):
        self.assertEqual(self.run_hook(b'not json'), (0, b''))
        self.assertEqual(self.run_hook(b'[1, 2]'), (0, b''))
        self.paths.spool.rmdir()
        self.paths.spool.write_text('a file where the spool dir should be', encoding='utf-8')
        self.assertEqual(self.run_hook({**BASE, 'hook_event_name': 'Stop'}), (0, b''))
        self.assertEqual(self.paths.hook_errors.read_text(encoding='utf-8').count('hook failed'), 3)

    def test_hourly_cleanup_purges_old_files_once_per_hour(self):
        spool = self.paths.spool
        for day in ('20260930', '20261001', '20261002', '20261009'):
            (spool / f'events-{day}.jsonl').write_text('', encoding='utf-8')
        old, fresh = (NOW - timedelta(days=8)).timestamp(), NOW.timestamp()
        stale_trash = self.paths.trash / '20260901T000000000Z-a.jsonl'
        fresh_trash = self.paths.trash / '20261009T000000000Z-b.jsonl'
        orphan = common.answer_path(self.paths, 'ZZZZZZZZ')
        for path, stamp in ((stale_trash, old), (fresh_trash, fresh), (orphan, old)):
            path.write_text('{}', encoding='utf-8')
            os.utime(path, (stamp, stamp))
        self.run_hook({**BASE, 'hook_event_name': 'Stop'})
        self.assertEqual(sorted(p.name for p in spool.glob('events-*.jsonl')),
                         ['events-20261002.jsonl', 'events-20261009.jsonl'])
        self.assertEqual([p.name for p in self.paths.trash.iterdir()], [fresh_trash.name])
        self.assertFalse(orphan.exists())
        (spool / 'events-20260901.jsonl').write_text('', encoding='utf-8')
        self.now = NOW + timedelta(minutes=30)
        self.run_hook({**BASE, 'hook_event_name': 'Stop'})
        self.assertTrue((spool / 'events-20260901.jsonl').exists())
        self.now = NOW + timedelta(minutes=61)
        self.run_hook({**BASE, 'hook_event_name': 'Stop'})
        self.assertFalse((spool / 'events-20260901.jsonl').exists())

    def test_session_start_does_not_run_cleanup(self):
        (self.paths.spool / 'events-20200101.jsonl').write_text('', encoding='utf-8')
        self.run_hook({**BASE, 'hook_event_name': 'SessionStart', 'source': 'startup'})
        self.assertTrue((self.paths.spool / 'events-20200101.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
