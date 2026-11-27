"""luady-report: a session tells Luady about a ready result mid-turn (spool `report` event)."""
from __future__ import annotations

import io
from datetime import datetime, timezone

from luady_kit import hook, report
from tests.helpers import HomeTestCase
from tests.test_hook_events import fake_tmux

NOW = datetime(2026, 10, 29, 8, 0, 0, tzinfo=timezone.utc)


class ReportTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='ash')
        self.tmux, self.tmux_calls = fake_tmux('cc-harbor-new-home:0.0\t4242')

    def run_report(self, argv, stdin=b'', environ=None):
        env = hook.HookEnv(paths=self.paths, tmux=self.tmux, now=lambda: NOW,
                           environ={'TMUX_PANE': '%3'} if environ is None else environ)
        out, err = io.StringIO(), io.StringIO()
        code = report.main(argv, stdin=io.BytesIO(stdin), stdout=out, stderr=err, env=env)
        return code, out.getvalue(), err.getvalue()

    def test_argument_text_becomes_a_report_event_for_this_pane(self):
        code, out, _ = self.run_report(['Fresh', 'account:', 'a@x.com', '/', 'pw'])
        self.assertEqual(code, 0)
        self.assertIn('Sent to Luady', out)
        [event] = self.spool_events()
        self.assertEqual((event['event'], event['host'], event['tmux'], event['data']),
                         ('report', 'ash', 'cc-harbor-new-home:0.0', {'text': 'Fresh account: a@x.com / pw'}))
        # No cwd: a session that cd'ed into a subfolder must not move its row to another project.
        self.assertEqual((event['cwd'], event['session_id'], event['ts']), (None, None, '2026-10-29T08:00:00.000Z'))

    def test_the_text_is_redacted(self):
        token = 'ghp_' + 'Q7x' * 12
        self.assertEqual(self.run_report(['ready:', 'API_KEY=abc123', 'and', token])[0], 0)
        [event] = self.spool_events()
        self.assertEqual(event['data'], {'text': 'ready: API_KEY=[redacted] and [redacted]'})

    def test_reads_stdin_without_arguments_and_cuts_long_text(self):
        self.assertEqual(self.run_report([], stdin=('x' * 5000).encode())[0], 0)
        [event] = self.spool_events()
        self.assertEqual(len(event['data']['text']), report.REPORT_MAX)

    def test_refuses_empty_text_and_shells_outside_tmux(self):
        self.assertEqual(self.run_report(['  '])[0], 2)
        code, _, err = self.run_report(['ready'], environ={})
        self.assertEqual(code, 3)
        self.assertIn('tmux', err)
        self.assertEqual(self.spool_events(), [])
