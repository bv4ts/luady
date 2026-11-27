"""luady-ctl start/stop/restart against a real tmux server and the fake claude."""
from __future__ import annotations

import time
import unittest

from luady_kit import common
from tests.ctl_helpers import fast_ctx, run_ctl
from tests.helpers import wait_until
from tests.tmux_helpers import TmuxTestCase, fake_log, submits, tmux


def rc(ctx, project):
    return ['--remote-control', f"{common.load_config(ctx.paths)['host_alias']} · {project}"]


def starts(cwd):
    return [event for event in fake_log(cwd) if event['type'] == 'start']


class CtlLifecycleTest(TmuxTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = fast_ctx(self.home, projects_root=str(self.projects))

    def test_start_runs_claude_with_c3_argv_and_prompt_from_stdin(self):
        cwd = self.project('app')
        prompt = 'Fix the "login" bug: `npm test` then $(echo done) — شكرا'
        code, out = run_ctl(self.ctx, 'start', '--name', 'app', '--cwd', str(cwd), '--model', 'opus',
                            stdin=prompt.encode('utf-8'))
        self.assertEqual((code, out), (0, {'ok': True, 'target': 'cc-app:0.0'}))
        self.assertEqual(starts(cwd)[0]['argv'], ['--permission-mode', 'bypassPermissions', '--model', 'opus', *rc(self.ctx, 'app'), prompt])
        self.assertIn(prompt, submits(cwd))

    def test_start_without_prompt_and_with_resume(self):
        cwd = self.project('beta')
        code, out = run_ctl(self.ctx, 'start', '--name', 'beta', '--cwd', str(cwd), '--resume', 'sid-42')
        self.assertEqual((code, out['target']), (0, 'cc-beta:0.0'))
        self.assertEqual(starts(cwd)[0]['argv'], ['--permission-mode', 'bypassPermissions', '--resume', 'sid-42', *rc(self.ctx, 'beta')])

    def test_start_selects_yes_in_trust_dialog_never_plain_enter(self):
        # 2.1.296 preselects "No, exit": a plain Enter would quit, so start must move to "Yes" first.
        cwd = self.project('fresh')
        (cwd / '.fake_trust').write_text('', encoding='utf-8')
        slow = fast_ctx(self.home, projects_root=str(self.projects), monotonic=lambda: time.monotonic() * 4)
        self.assertEqual(run_ctl(slow, 'start', '--name', 'fresh', '--cwd', str(cwd))[0], 0)
        self.assertEqual([event['type'] for event in fake_log(cwd)][:3], ['start', 'trust_accepted', 'ready'])
        self.assertNotIn('trust_declined', [event['type'] for event in fake_log(cwd)])

    def test_start_refusals(self):
        outside = self.home / 'elsewhere'
        outside.mkdir()
        for cwd in (outside, self.projects, self.projects / 'missing'):
            code, out = run_ctl(self.ctx, 'start', '--name', 'x', '--cwd', str(cwd))
            self.assertEqual((code, out['error']['code']), (3, 'refused'), cwd)
        cwd = self.project('dup')
        self.assertEqual(run_ctl(self.ctx, 'start', '--name', 'dup', '--cwd', str(cwd))[0], 0)
        code, out = run_ctl(self.ctx, 'start', '--name', 'dup', '--cwd', str(cwd))
        self.assertEqual((code, out['error']['code']), (3, 'refused'))

    def test_start_reports_a_session_that_dies(self):
        cwd = self.project('broken')
        self.paths.claude_bin.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
        code, out = run_ctl(self.ctx, 'start', '--name', 'broken', '--cwd', str(cwd))
        self.assertEqual((code, out['error']['code']), (1, 'failed'))

    def test_stop_graceful(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        self.assertEqual(run_ctl(self.ctx, 'stop', '--target', target), (0, {'ok': True, 'forced': False}))
        self.assertFalse(self.session_exists('cc-app'))
        self.assertEqual(submits(cwd)[-1], '/exit')
        self.assertIn({'type': 'key', 'key': 'Escape'}, fake_log(cwd))

    def test_stop_kills_after_grace_when_claude_ignores_exit(self):
        cwd = self.project('stubborn')
        (cwd / '.fake_ignore_exit').write_text('', encoding='utf-8')
        target = self.start_claude_pane('cc-stubborn', cwd)
        self.assertEqual(run_ctl(self.ctx, 'stop', '--target', target), (0, {'ok': True, 'forced': True}))
        self.assertFalse(self.session_exists('cc-stubborn'))

    def test_stop_force_and_shell_refusal(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        self.assertEqual(run_ctl(self.ctx, 'stop', '--target', target, '--force'), (0, {'ok': True, 'forced': True}))
        tmux('new-session', '-d', '-s', 'cc-shell', '-c', str(cwd), '--', 'sleep', '300')
        code, out = run_ctl(self.ctx, 'stop', '--target', 'cc-shell:0.0')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))
        self.assertEqual(run_ctl(self.ctx, 'stop', '--target', 'cc-shell:0.0', '--force'),
                         (0, {'ok': True, 'forced': True}))

    def test_restart_resumes_registered_session_in_same_pane(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        entry = common.registry_for_target(common.list_registry(self.paths), target, None)
        self.assertIsNotNone(entry)
        self.assertEqual(run_ctl(self.ctx, 'restart', '--target', target), (0, {'ok': True}))
        wait_until(lambda: len(starts(cwd)) == 2)
        self.assertEqual(starts(cwd)[-1]['argv'],
                         ['--permission-mode', 'bypassPermissions', '--resume', entry['session_id'], *rc(self.ctx, 'app')])
        self.assertTrue(self.session_exists('cc-app'))

    def test_restart_needs_registry(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        for path in self.paths.registry.glob('*.json'):
            path.unlink()
        code, out = run_ctl(self.ctx, 'restart', '--target', target)
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))


if __name__ == '__main__':
    unittest.main()
