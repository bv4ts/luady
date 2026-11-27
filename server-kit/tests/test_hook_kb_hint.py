"""Kit 2.1: the SessionStart hook points the session at ~/luady-kb when the knowledge base exists."""
from __future__ import annotations

import io
import json
import unittest
from unittest import mock

from luady_kit import hook
from tests.helpers import HomeTestCase
from tests.test_hook_events import BASE, NOW, fake_tmux


class KbHintTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='cedar')
        self.tmux, _ = fake_tmux()
        self.kb = self.home / 'luady-kb'

    def run_hook(self, payload):
        env = hook.HookEnv(paths=self.paths, tmux=self.tmux, environ={'TMUX_PANE': '%7'}, now=lambda: NOW)
        out = io.BytesIO()
        code = hook.main(stdin=io.BytesIO(json.dumps(payload).encode('utf-8')), stdout=out, env=env)
        return code, out.getvalue()

    def start(self, **extra):
        return self.run_hook({**BASE, 'hook_event_name': 'SessionStart', 'source': 'startup', **extra})

    def context(self, raw):
        output = json.loads(raw)
        self.assertEqual(set(output), {'hookSpecificOutput'})
        self.assertEqual(set(output['hookSpecificOutput']), {'hookEventName', 'additionalContext'})
        self.assertEqual(output['hookSpecificOutput']['hookEventName'], 'SessionStart')
        return output['hookSpecificOutput']['additionalContext']

    def make_index(self, *projects):
        self.kb.mkdir()
        (self.kb / 'INDEX.md').write_text('# Index\n', encoding='utf-8')
        for name in projects:
            (self.kb / name).mkdir()

    def test_no_index_prints_nothing_and_records_as_before(self):
        self.assertEqual(self.start(), (0, b''))
        self.kb.mkdir()
        self.assertEqual(self.start(), (0, b''))
        self.assertEqual([e['event'] for e in self.spool_events()], ['session_start', 'session_start'])

    def test_index_without_project_folder(self):
        self.make_index('other')
        code, raw = self.start()
        self.assertEqual(code, 0)
        text = self.context(raw)
        self.assertIn(f'{self.kb}/', text)
        self.assertIn(f'{self.kb}/INDEX.md', text)
        self.assertNotIn(f'{self.kb}/app/', text)
        self.assertLess(len(text), 400)
        self.assertEqual(self.spool_events()[0]['data'], {'source': 'startup', 'model': None})

    def test_index_with_project_folder(self):
        self.make_index('app')
        text = self.context(self.start()[1])
        self.assertIn(f'{self.kb}/app/', text)
        self.assertLess(len(text), 400)

    def test_every_source_gets_the_line(self):
        self.make_index('app')
        for source in ('resume', 'clear', 'compact'):
            with self.subTest(source=source):
                self.assertIn(f'{self.kb}/app/', self.context(self.start(source=source)[1]))

    def test_odd_or_missing_cwd_names_no_project(self):
        self.make_index('app')
        for cwd in (None, '', '/', '/home/dev/projects/sp ace', 42, '/home/dev/projects/' + 'x' * 90):
            with self.subTest(cwd=cwd):
                text = self.context(self.start(cwd=cwd)[1])
                self.assertNotIn(f'{self.kb}/app/', text)
                self.assertLess(len(text), 400)

    def test_cwd_with_trailing_slash(self):
        self.make_index('app')
        self.assertIn(f'{self.kb}/app/', self.context(self.start(cwd='/home/dev/projects/app/')[1]))

    def test_project_symlink_out_of_the_folder_is_not_named(self):
        self.make_index()
        (self.home / 'elsewhere').mkdir()
        (self.kb / 'app').symlink_to(self.home / 'elsewhere')
        self.assertNotIn(f'{self.kb}/app/', self.context(self.start()[1]))

    def test_the_self_host_gets_no_line(self):
        self.write_config(host_alias='hq')
        self.make_index('app')
        self.assertEqual(self.start(), (0, b''))
        self.assertEqual(self.spool_events()[0]['event'], 'session_start')

    def test_other_events_get_no_line(self):
        self.make_index('app')
        self.assertEqual(self.run_hook({**BASE, 'hook_event_name': 'Stop', 'last_assistant_message': 'x'}), (0, b''))

    def test_a_failing_hint_is_swallowed_and_logged(self):
        self.make_index('app')
        with mock.patch.object(hook, 'kb_context', side_effect=RuntimeError('boom')):
            self.assertEqual(self.start(), (0, b''))
        self.assertEqual(self.spool_events()[0]['event'], 'session_start')
        self.assertIn('boom', self.paths.hook_errors.read_text(encoding='utf-8'))

    def test_kb_context_directly(self):
        self.assertIsNone(hook.kb_context(self.paths, '/home/dev/projects/app'))
        self.make_index('app')
        self.assertIn('app', hook.kb_context(self.paths, '/home/dev/projects/app'))


if __name__ == '__main__':
    unittest.main()
