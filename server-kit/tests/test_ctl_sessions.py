"""The sessions verb (registry join, unregistered best guess, pending) and the delete verb."""
from __future__ import annotations

import os
import unittest
from pathlib import Path

from luady_kit import common, transcripts
from tests.ctl_helpers import fast_ctx, run_ctl
from tests.tmux_helpers import TmuxTestCase, tmux


class CtlSessionsTest(TmuxTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = fast_ctx(self.home, projects_root=str(self.projects))

    def registry_entry(self, target):
        return common.registry_for_target(common.list_registry(self.paths), target, None)

    def test_registered_unregistered_and_shell_panes(self):
        app_cwd = self.project('app')
        target = self.start_claude_pane('cc-app', app_cwd)
        legacy_cwd = self.project('legacy')
        legacy_target = self.start_claude_pane('cc-legacy', legacy_cwd)
        common.remove_registry(self.paths, self.registry_entry(legacy_target)['session_id'])
        guess_dir = self.paths.claude_projects / transcripts.encode_project_dir(str(legacy_cwd))
        guess_dir.mkdir(parents=True)
        (guess_dir / 'old-1.jsonl').write_text('{}\n', encoding='utf-8')
        os.utime(guess_dir / 'old-1.jsonl', (1, 1))
        (guess_dir / 'new-2.jsonl').write_text('{}\n', encoding='utf-8')
        tmux('new-session', '-d', '-s', 'cc-shell', '-c', str(app_cwd), '--', 'sleep', '300')
        own = os.getpid()
        common.atomic_write_json(common.pending_path(self.paths, 'PPPPPPPP'), {
            'qid': 'PPPPPPPP', 'kind': 'question', 'created_at': '2026-10-09T10:00:00.000Z', 'session_id': 's',
            'tmux': target, 'payload': {}, 'meta': {}, 'pid': own, 'pid_start': common.proc_start_ticks(own)})
        code, out = run_ctl(self.ctx, 'sessions')
        self.assertEqual(code, 0)
        rows = {row['target']: row for row in out['sessions']}
        app = rows[target]
        self.assertEqual({key: app[key] for key in ('tmux_session', 'command', 'cwd', 'is_claude', 'session_id',
                                                     'registered', 'pending_qid')},
                         {'tmux_session': 'cc-app', 'command': 'claude', 'cwd': str(app_cwd), 'is_claude': True,
                          'session_id': self.registry_entry(target)['session_id'], 'registered': True,
                          'pending_qid': 'PPPPPPPP'})
        self.assertEqual(app['pane_pid'], self.pane_pid(target))
        legacy = rows[legacy_target]
        self.assertEqual((legacy['registered'], legacy['session_id'], legacy['transcript_path']),
                         (False, 'new-2', str(guess_dir / 'new-2.jsonl')))
        shell = rows['cc-shell:0.0']
        self.assertEqual((shell['is_claude'], shell['session_id'], shell['registered'], shell['pending_qid']),
                         (False, None, False, None))
        self.assertIn('keeper:0.0', rows)

    def test_sessions_without_a_tmux_server(self):
        tmux('kill-server')
        self.assertEqual(run_ctl(self.ctx, 'sessions'), (0, {'sessions': []}))

    def test_delete_stops_live_pane_and_moves_transcript_to_trash(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        sid = self.registry_entry(target)['session_id']
        folder = self.paths.claude_projects / transcripts.encode_project_dir(str(cwd))
        folder.mkdir(parents=True)
        (folder / f'{sid}.jsonl').write_text('{"uuid": "a"}\n', encoding='utf-8')
        code, out = run_ctl(self.ctx, 'delete', '--session', sid)
        self.assertEqual(code, 0, out)
        self.assertRegex(out['trashed'], rf'/\.luady/trash/\d{{8}}T\d{{9}}Z-{sid}\.jsonl$')
        self.assertEqual(Path(out['trashed']).read_text(encoding='utf-8'), '{"uuid": "a"}\n')
        self.assertFalse((folder / f'{sid}.jsonl').exists())
        self.assertFalse(self.session_exists('cc-app'))
        self.assertIsNone(common.read_registry(self.paths, sid))

    def test_delete_of_unknown_session_is_not_found(self):
        code, out = run_ctl(self.ctx, 'delete', '--session', 'missing-1')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))

    def test_delete_of_ended_session_only_moves_the_transcript(self):
        folder = self.paths.claude_projects / '-old'
        folder.mkdir(parents=True)
        (folder / 'ended-1.jsonl').write_text('{}\n', encoding='utf-8')
        code, out = run_ctl(self.ctx, 'delete', '--session', 'ended-1')
        self.assertEqual(code, 0)
        self.assertTrue(Path(out['trashed']).exists())
        self.assertFalse((folder / 'ended-1.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
