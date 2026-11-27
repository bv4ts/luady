"""luady-ctl send/keys/capture against a real tmux server and the fake claude."""
from __future__ import annotations

import os
import threading
import time
import unittest
from pathlib import Path

from luady_kit import common
from tests.ctl_helpers import fast_ctx, run_ctl
from tests.helpers import wait_until
from tests.tmux_helpers import TmuxTestCase, fake_log, submits, tmux, wait_for_event

TEXT = ('مرحبا يا صديقي — "double" \'single\' `backticks` $(touch /tmp/luady-pwned) ${HOME} $HOME\n'
        'second line 🚀👍🏽; && || > < | \\ backslash\n'
        '\tindented third line…')


class CtlSendTest(TmuxTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = fast_ctx(self.home, projects_root=str(self.projects))
        self.cwd = self.project('app')
        self.target = self.start_claude_pane('cc-app', self.cwd)

    def test_send_preserves_unicode_and_shell_chars(self):
        code, out = run_ctl(self.ctx, 'send', '--target', self.target, stdin=TEXT.encode('utf-8'))
        self.assertEqual((code, out), (0, {'ok': True}))
        wait_until(lambda: submits(self.cwd) == [TEXT])
        self.assertFalse(Path('/tmp/luady-pwned').exists())

    def test_send_is_byte_exact_for_tmux_hostile_lines(self):
        cases = [
            'ends with semicolon;',
            'ends with backslash semicolon \\;',
            'many;;;',
            ';',
            '\\;',
            '\\',
            '-leading dash',
            '--',
            '-l -- x',
            'first\n\n\nlast after empty lines',
            '\nstarts with newline',
            'مرحبا 🚀👍🏽 "q" \'s\' `bt` $(touch /tmp/luady-pwned) ${HOME}',
            'one\n;\n\\;\n-x\n',
        ]
        for text in cases:
            before = len(submits(self.cwd))
            code, out = run_ctl(self.ctx, 'send', '--target', self.target, stdin=text.encode('utf-8'))
            self.assertEqual((code, out), (0, {'ok': True}), text)
            wait_until(lambda: len(submits(self.cwd)) == before + 1)
            self.assertEqual(submits(self.cwd)[-1], text, repr(text))
        self.assertFalse(Path('/tmp/luady-pwned').exists())

    def test_exact_target_never_prefix_matches(self):
        other = self.project('app2')
        self.start_claude_pane('cc-app2', other)
        tmux('kill-session', '-t', '=cc-app')
        for argv in (('send', '--target', 'cc-app:0.0'), ('keys', '--target', 'cc-app:0.0', '--key', 'Enter'),
                     ('capture', '--target', 'cc-app:0.0', '--lines', '5'), ('stop', '--target', 'cc-app:0.0')):
            code, out = run_ctl(self.ctx, *argv, stdin=b'hello')
            self.assertEqual((code, out['error']['code']), (4, 'not_found'), argv)
        time.sleep(0.5)
        self.assertEqual(submits(other), [])

    def test_concurrent_sends_do_not_cross(self):
        other_cwd = self.project('beta')
        other = self.start_claude_pane('cc-beta', other_cwd)
        texts = {self.target: 'alpha message\nline two', other: 'beta message\nline two'}
        codes = []

        def worker(target):
            for _ in range(5):
                codes.append(run_ctl(self.ctx, 'send', '--target', target, stdin=texts[target].encode('utf-8'))[0])

        threads = [threading.Thread(target=worker, args=(target,)) for target in texts]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertEqual(codes, [0] * 10)
        wait_until(lambda: len(submits(self.cwd)) == 5 and len(submits(other_cwd)) == 5, timeout=20)
        self.assertEqual(set(submits(self.cwd)), {texts[self.target]})
        self.assertEqual(set(submits(other_cwd)), {texts[other]})

    def test_send_refuses_non_claude_pane(self):
        tmux('new-session', '-d', '-s', 'cc-shell', '-c', str(self.cwd), '--', 'sleep', '300')
        code, out = run_ctl(self.ctx, 'send', '--target', 'cc-shell:0.0', stdin=b'ls')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))

    def test_send_refuses_while_question_pending(self):
        own = os.getpid()
        common.atomic_write_json(common.pending_path(self.paths, 'QQQQQQQQ'), {
            'qid': 'QQQQQQQQ', 'kind': 'question', 'created_at': '2026-10-09T10:00:00.000Z', 'session_id': 's',
            'tmux': self.target, 'payload': {}, 'meta': {}, 'pid': own, 'pid_start': common.proc_start_ticks(own)})
        code, out = run_ctl(self.ctx, 'send', '--target', self.target, stdin=b'hi')
        self.assertEqual((code, out), (3, {'error': {'code': 'refused', 'message': 'question pending: QQQQQQQQ'}}))
        self.assertEqual(submits(self.cwd), [])

    def test_send_validates_text(self):
        for data in (b'', b'  \n', b'x' * 20001, b'\xff', b'a\x00b'):
            code, out = run_ctl(self.ctx, 'send', '--target', self.target, stdin=data)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), data[:10])

    def test_keys_and_capture(self):
        self.assertEqual(run_ctl(self.ctx, 'keys', '--target', self.target, '--key', 'C-c'), (0, {'ok': True}))
        self.assertEqual(run_ctl(self.ctx, 'keys', '--target', self.target, '--key', 'Escape'), (0, {'ok': True}))
        wait_for_event(self.cwd, lambda event: event.get('key') == 'Escape')
        self.assertIn({'type': 'key', 'key': 'C-c'}, fake_log(self.cwd))
        code, out = run_ctl(self.ctx, 'capture', '--target', self.target, '--lines', '20')
        self.assertEqual(code, 0)
        self.assertIn('FAKE CLAUDE READY', out['text'])


if __name__ == '__main__':
    unittest.main()
