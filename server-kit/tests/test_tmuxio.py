"""Unit tests for luady_kit.tmuxio: argv construction, exact targets, version gating and claude detection."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from luady_kit import tmuxio
from luady_kit.common import RunResult
from luady_kit.tmuxio import Pane, Tmux, TmuxError
from tests.ctl_helpers import make_ctx, run_ctl


class Recorder:
    """A fake run_process keyed by the tmux subcommand (argv[1])."""

    def __init__(self, outputs=None):
        self.calls = []
        self.outputs = outputs or {}

    def __call__(self, argv, input_bytes=None, timeout=10.0, cwd=None):
        self.calls.append((argv, input_bytes))
        code, out = self.outputs.get(argv[1], (0, ''))
        return RunResult(code, out.encode('utf-8'), b'boom' if code else b'')


class TmuxWrapperTest(unittest.TestCase):
    def test_every_pane_target_is_exact(self):
        rec = Recorder()
        tm = Tmux(rec)
        tm.send_keys('cc-app:0.0', 'Enter')
        tm.send_literal('cc-app:0.0', '/exit')
        tm.capture('cc-app:0.0', 50)
        tm.kill_pane('cc-app:0.0')
        tm.respawn_pane('cc-app:0.0', '/w', ['claude', '--resume', 'x'])
        self.assertEqual([argv for argv, _ in rec.calls], [
            ['tmux', 'send-keys', '-t', '=cc-app:0.0', 'Enter'],
            ['tmux', 'send-keys', '-t', '=cc-app:0.0', '-l', '/exit'],
            ['tmux', 'capture-pane', '-p', '-t', '=cc-app:0.0', '-S', '-50'],
            ['tmux', 'kill-pane', '-t', '=cc-app:0.0'],
            ['tmux', 'respawn-pane', '-k', '-t', '=cc-app:0.0', '-c', '/w', '--', 'claude', '--resume', 'x'],
        ])

    def test_exact_keeps_ids_and_existing_prefix(self):
        self.assertEqual(tmuxio.exact('%3'), '%3')
        self.assertEqual(tmuxio.exact('=a:0.0'), '=a:0.0')
        self.assertEqual(tmuxio.exact('a:0.0'), '=a:0.0')

    def test_send_text_types_each_line_literally_with_s_enter_between(self):
        rec = Recorder()
        text = '-x $(id)\n\nend;\r\n\\;;'
        with tempfile.TemporaryDirectory() as tmp:
            tmuxio.send_text(Tmux(rec), Path(tmp) / 'send.lock', 'cc-a:0.0', text, lambda s: None)
        base = ['tmux', 'send-keys', '-t', '=cc-a:0.0']
        self.assertEqual([argv for argv, _ in rec.calls], [
            [*base, '-l', '--', '-x $(id)'],
            [*base, 'S-Enter'],
            [*base, 'S-Enter'],
            [*base, '-l', '--', 'end'],
            [*base, '-l', '--', '\\;'],
            [*base, 'S-Enter'],
            [*base, '-l', '--', '\\'],
            [*base, '-l', '--', '\\;'],
            [*base, '-l', '--', '\\;'],
            [*base, 'Enter'],
            ['tmux', 'capture-pane', '-p', '-t', '=cc-a:0.0', '-S', '-40'],
        ])

    def test_send_text_presses_enter_again_while_the_text_stays_in_the_input_box(self):
        rule = '─' * 60
        stuck = '\n'.join([
            '✻ Worked for 23s', rule, '❯ [Chat · Sun 22:27]',
            '  https://github.com/example-org/orchard-backend/pull/550',
            '  after last commit from me or not ? , please check', rule, "  ⏵⏵ don't ask on",
        ])
        sent = '\n'.join(['✢ Mustering…', rule, '❯ ', rule, '  esc to interrupt'])
        screens = [stuck, stuck, sent]

        class Screens(Recorder):
            def __call__(self, argv, input_bytes=None, timeout=10.0, cwd=None):
                if argv[1] == 'capture-pane':
                    self.calls.append((argv, input_bytes))
                    return RunResult(0, screens.pop(0).encode('utf-8'), b'')
                return super().__call__(argv, input_bytes, timeout, cwd)

        rec = Screens()
        text = ('[Chat · Sun 22:27] https://github.com/example-org/orchard-backend/pull/550 \n'
                'after last commit from me or not ? , please check')
        waits = []
        with tempfile.TemporaryDirectory() as tmp:
            tmuxio.send_text(Tmux(rec), Path(tmp) / 'send.lock', 'luady:0.0', text, waits.append)
        keys = [argv[4] for argv, _ in rec.calls if argv[1] == 'send-keys' and argv[4] in ('Enter', 'S-Enter')]
        self.assertEqual(keys, ['S-Enter', 'Enter', 'Enter', 'Enter'])
        self.assertEqual(waits, [tmuxio.SEND_PAUSE_SECONDS, 0.5, 1.0, 2.0])

    def test_still_unsent_ignores_other_text_and_missing_boxes(self):
        rule = '─' * 30
        self.assertFalse(tmuxio.still_unsent('no box here', 'hello'))
        self.assertFalse(tmuxio.still_unsent(f'{rule}\n❯ suggested follow-up\n{rule}', 'hello there'))
        self.assertTrue(tmuxio.still_unsent(f'{rule}\n❯ hello\n  there\n{rule}', 'hello there'))

    def test_failures_raise_and_list_panes_tolerates_no_server(self):
        rec = Recorder({'send-keys': (1, ''), 'list-panes': (1, '')})
        with self.assertRaises(TmuxError):
            Tmux(rec).send_keys('cc-a:0.0', 'Enter')
        self.assertEqual(Tmux(rec).list_panes(), [])

    def test_parse_pane_keeps_tabs_in_cwd(self):
        pane = tmuxio.parse_pane('cc-a:0.0\tcc-a\t42\tclaude\t/w/with\ttab')
        self.assertEqual(pane, Pane('cc-a:0.0', 'cc-a', 42, 'claude', '/w/with\ttab'))
        self.assertIsNone(tmuxio.parse_pane('garbage'))

    def test_claude_argv(self):
        self.assertEqual(tmuxio.claude_argv('/h/claude', 'opus', 'sid-1', '-v please'),
                         ['/h/claude', '--permission-mode', 'bypassPermissions', '--model', 'opus',
                          '--resume', 'sid-1', ' -v please'])
        self.assertEqual(tmuxio.claude_argv('/h/claude', None, None, None),
                         ['/h/claude', '--permission-mode', 'bypassPermissions'])
        self.assertEqual(tmuxio.claude_argv('/h/claude', None, 'sid-1', 'fix it', 'cedar · meadow-vat'),
                         ['/h/claude', '--permission-mode', 'bypassPermissions', '--resume', 'sid-1',
                          '--remote-control', 'cedar · meadow-vat', 'fix it'])


class ClaudeDetectionTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proc = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def add(self, pid, ppid, argv0, exe=None):
        folder = self.proc / str(pid)
        folder.mkdir()
        (folder / 'stat').write_text(f'{pid} (x y) S {ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 555 0 0\n')
        (folder / 'cmdline').write_bytes(argv0.encode('utf-8') + b'\0--flag\0')
        if exe:
            os.symlink(exe, folder / 'exe')

    def test_child_with_argv0_claude_is_detected(self):
        self.add(100, 1, '-bash')
        self.add(101, 100, '/home/dev/.local/bin/claude')
        self.assertTrue(tmuxio.is_claude_pane(Pane('a:0.0', 'a', 100, 'bash', '/'), str(self.proc)))

    def test_versioned_native_binary_is_detected(self):
        self.add(200, 1, '2.1.295', exe='/home/dev/.local/share/claude/versions/2.1.295')
        self.assertTrue(tmuxio.is_claude_pane(Pane('a:0.0', 'a', 200, '2.1.295', '/'), str(self.proc)))

    def test_shell_pane_is_not_claude(self):
        self.add(300, 1, '-bash')
        self.add(301, 300, 'vim', exe='/usr/bin/vim')
        self.assertFalse(tmuxio.is_claude_pane(Pane('a:0.0', 'a', 300, 'bash', '/'), str(self.proc)))

    def test_pane_command_claude_short_circuits(self):
        self.assertTrue(tmuxio.is_claude_pane(Pane('a:0.0', 'a', 999999, 'claude', '/'), str(self.proc)))


class TypedTextTest(unittest.TestCase):
    """send and start refuse a control character before they look at any pane."""

    def run_verb(self, verb, text):
        rec = Recorder()
        ctx = make_ctx(Path(tempfile.gettempdir()) / 'luady-typed-text-home', run=rec)
        argv = ('send', '--target', 'cc-app:0.0') if verb == 'send' else ('start', '--name', 'app', '--cwd', '/srv/x')
        return run_ctl(ctx, *argv, stdin=text.encode('utf-8')), rec.calls

    def test_control_characters_are_refused(self):
        for char in ('\x00', '\x03', '\x04', '\x08', '\x0b', '\x0c', '\x1a', '\x1b', '\x1f', '\x7f'):
            for verb in ('send', 'start'):
                with self.subTest(char=repr(char), verb=verb):
                    (code, out), calls = self.run_verb(verb, f'hello{char}{char}\nrm -rf ~/projects')
                    self.assertEqual((code, out['error']['code']), (2, 'usage'))
                    self.assertIn(f'U+{ord(char):04X}', out['error']['message'])
                    self.assertEqual(calls, [])

    def test_line_breaks_and_tabs_are_text(self):
        for text in ('one\ntwo', 'one\r\ntwo', 'one\rtwo', '\tindented', 'مرحبا 🚀 "q" `bt` $(x) \\ ;'):
            with self.subTest(text=repr(text)):
                self.assertIsNone(tmuxio.CONTROL_CHAR.search(text))


if __name__ == '__main__':
    unittest.main()
