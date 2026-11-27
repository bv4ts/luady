"""Transcript windows: tail / from / before return complete lines only."""
from __future__ import annotations

import json
import unittest

from luady_kit import common, transcripts
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase

SID = '0b3f6c1e-1111-4222-8333-944455556666'


def rec(n, pad=0):
    return (json.dumps({'uuid': f'u{n}', 'type': 'user', 'text': 'x' * pad + 'م'}) + '\n').encode('utf-8')


class CtlTranscriptTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = make_ctx(self.home)
        folder = self.paths.claude_projects / '-home-dev-projects-app'
        folder.mkdir(parents=True)
        self.path = folder / f'{SID}.jsonl'
        self.lines = [rec(n) for n in range(10)]
        self.path.write_bytes(b''.join(self.lines))
        self.size = self.path.stat().st_size
        self.width = len(self.lines[0])

    def window(self, *args):
        code, out = run_ctl(self.ctx, 'transcript', '--session', SID, *args)
        self.assertEqual(code, 0, out)
        return out

    def test_tail_returns_last_complete_lines(self):
        out = self.window('--tail', str(self.width * 3 + 5))
        self.assertEqual(out['data'].encode('utf-8'), b''.join(self.lines[-3:]))
        self.assertEqual((out['from'], out['to'], out['size'], out['path']),
                         (self.size - 3 * self.width, self.size, self.size, str(self.path)))

    def test_tail_ignores_incomplete_last_line(self):
        with self.path.open('ab') as handle:
            handle.write(b'{"uuid": "partial"')
        out = self.window('--tail', '100000')
        self.assertEqual(out['data'].encode('utf-8'), b''.join(self.lines))
        self.assertEqual(out['to'], self.size)

    def test_from_and_before_page_without_gaps(self):
        first = self.window('--from', '0', '--max', str(self.width * 4 + 3))
        self.assertEqual((first['from'], first['to']), (0, self.width * 4))
        second = self.window('--from', str(first['to']), '--max', str(self.width * 100))
        self.assertEqual(second['data'].encode('utf-8'), b''.join(self.lines[4:]))
        at_end = self.window('--from', str(self.size), '--max', '100')
        self.assertEqual((at_end['data'], at_end['from'], at_end['to']), ('', self.size, self.size))
        older = self.window('--before', str(self.width * 4), '--max', str(self.width * 2 + 1))
        self.assertEqual(older['data'].encode('utf-8'), b''.join(self.lines[2:4]))
        self.assertEqual((older['from'], older['to']), (self.width * 2, self.width * 4))
        self.assertEqual(self.window('--before', '0', '--max', '10')['data'], '')

    def test_offsets_must_be_line_boundaries_inside_the_file(self):
        for args in (('--from', '3', '--max', '10'), ('--before', '3', '--max', '10'),
                     ('--from', str(self.size + 1), '--max', '10')):
            code, out = run_ctl(self.ctx, 'transcript', '--session', SID, *args)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), args)

    def test_oversized_line_becomes_a_placeholder(self):
        big = rec(99, pad=5000)
        self.path.write_bytes(self.lines[0] + big + self.lines[1])
        out = self.window('--from', str(self.width), '--max', '1000')
        self.assertEqual(json.loads(out['data']), {'type': 'luady_skipped', 'bytes': len(big)})
        self.assertEqual((out['from'], out['to']), (self.width, self.width + len(big)))
        back = self.window('--before', str(self.width + len(big)), '--max', '1000')
        self.assertEqual(json.loads(back['data']), {'type': 'luady_skipped', 'bytes': len(big)})
        self.assertEqual((back['from'], back['to']), (self.width, self.width + len(big)))

    def test_lookup_via_registry_and_not_found(self):
        other = self.home / 'elsewhere.jsonl'
        other.write_bytes(self.lines[0])
        common.write_registry(self.paths, {'session_id': 'reg-1', 'transcript_path': str(other), 'tmux': 'x:0.0',
                                           'started_at': '2026-10-09T10:00:00.000Z'})
        self.assertEqual(run_ctl(self.ctx, 'transcript', '--session', 'reg-1', '--tail', '100')[1]['path'], str(other))
        code, out = run_ctl(self.ctx, 'transcript', '--session', 'nope-1', '--tail', '100')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))

    def test_encode_project_dir(self):
        self.assertEqual(transcripts.encode_project_dir('/home/dev/projects/meadow_hr.365'),
                         '-home-dev-projects-meadow-hr-365')


if __name__ == '__main__':
    unittest.main()
