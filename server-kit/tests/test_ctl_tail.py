"""Spool tailing: complete lines only, offsets after each line, UTC-midnight rotation, resume."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from luady_kit import transcripts
from luady_kit.transcripts import TailState, tail_step
from tests.helpers import HomeTestCase

KIT_ROOT = Path(__file__).resolve().parent.parent


def line(n: int) -> bytes:
    return (json.dumps({'v': 1, 'id': f'id-{n}', 'event': 'stop', 'n': n}) + '\n').encode('utf-8')


class TailTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.spool = self.paths.spool

    def write(self, day, *chunks):
        with open(self.spool / f'events-{day}.jsonl', 'ab') as handle:
            for chunk in chunks:
                handle.write(chunk)

    def test_follows_rotation(self):
        self.write('20261009', line(1), line(2))
        state, lines = tail_step(self.spool, transcripts.initial_state(self.spool, 'start'), 0.0, 2.0)
        size1 = len(line(1))
        self.assertEqual([(item['file'], item['offset'], item['event']['n']) for item in lines],
                         [('events-20261009.jsonl', size1, 1), ('events-20261009.jsonl', size1 + len(line(2)), 2)])
        self.write('20261010', line(3)[:10])
        state, lines = tail_step(self.spool, state, 1.0, 2.0)
        self.assertEqual(lines, [])
        state, lines = tail_step(self.spool, state, 4.0, 2.0)
        self.assertEqual((state.file, state.offset, lines), ('events-20261010.jsonl', 0, []))
        state, lines = tail_step(self.spool, state, 5.0, 2.0)
        self.assertEqual((lines, state.offset), ([], 0))
        self.write('20261010', line(3)[10:], line(4))
        state, lines = tail_step(self.spool, state, 6.0, 2.0)
        self.assertEqual([(item['file'], item['event']['n']) for item in lines],
                         [('events-20261010.jsonl', 3), ('events-20261010.jsonl', 4)])
        self.assertEqual(state.offset, len(line(3)) + len(line(4)))

    def test_rotation_drains_late_write_to_old_file(self):
        self.write('20261009', line(1))
        state, _ = tail_step(self.spool, transcripts.initial_state(self.spool, 'start'), 0.0, 2.0)
        self.write('20261010', line(10))
        state, _ = tail_step(self.spool, state, 1.0, 2.0)
        self.write('20261009', line(2))
        state, lines = tail_step(self.spool, state, 1.5, 2.0)
        self.assertEqual([item['event']['n'] for item in lines], [2])
        state, _ = tail_step(self.spool, state, 2.0, 2.0)
        state, _ = tail_step(self.spool, state, 5.0, 2.0)
        state, lines = tail_step(self.spool, state, 5.1, 2.0)
        self.assertEqual([(item['file'], item['event']['n']) for item in lines], [('events-20261010.jsonl', 10)])

    def test_resume_from_offset_and_end(self):
        self.write('20261009', line(1), line(2), line(3))
        state = transcripts.initial_state(self.spool, f'events-20261009.jsonl:{len(line(1))}')
        _, lines = tail_step(self.spool, state, 0.0, 2.0)
        self.assertEqual([item['event']['n'] for item in lines], [2, 3])
        end = transcripts.initial_state(self.spool, 'end')
        self.assertEqual((end.file, end.offset), ('events-20261009.jsonl', sum(len(line(n)) for n in (1, 2, 3))))
        self.assertEqual(tail_step(self.spool, end, 0.0, 2.0)[1], [])

    def test_missing_file_and_offset_beyond_size(self):
        self.write('20261009', line(1))
        state, _ = tail_step(self.spool, transcripts.initial_state(self.spool, 'events-20261001.jsonl:500'), 0.0, 2.0)
        self.assertEqual((state.file, state.offset), ('events-20261009.jsonl', 0))
        _, lines = tail_step(self.spool, TailState('events-20261009.jsonl', 10_000), 0.0, 2.0)
        self.assertEqual([item['event']['n'] for item in lines], [1])

    def test_invalid_json_lines_are_skipped(self):
        self.write('20261009', b'{not json}\n', b'[1,2]\n', line(5))
        _, lines = tail_step(self.spool, transcripts.initial_state(self.spool, 'start'), 0.0, 2.0)
        self.assertEqual([(item['event']['n'], item['offset']) for item in lines],
                         [(5, len(b'{not json}\n[1,2]\n') + len(line(5)))])

    def test_empty_spool_picks_up_the_first_file(self):
        state = transcripts.initial_state(self.spool, 'start')
        self.assertIsNone(state.file)
        self.assertEqual(tail_step(self.spool, state, 0.0, 2.0)[1], [])
        self.write('20261009', line(7))
        state, _ = tail_step(self.spool, state, 0.0, 2.0)
        self.assertEqual([item['event']['n'] for item in tail_step(self.spool, state, 0.0, 2.0)[1]], [7])

    def test_tail_loop_emits_lines_and_heartbeat(self):
        self.write('20261009', line(1))
        emitted, clock = [], [0.0]

        def sleep(seconds):
            clock[0] += seconds

        alive = []
        transcripts.tail_events(self.spool, 'start', emitted.append, now_iso=lambda: '2026-10-09T00:00:00.000Z',
                                monotonic=lambda: clock[0], sleep=sleep, should_stop=lambda: clock[0] > 61,
                                alive=lambda: alive.append(clock[0]))
        self.assertEqual(emitted[0]['event']['n'], 1)
        self.assertIn({'heartbeat': '2026-10-09T00:00:00.000Z'}, emitted)
        # at the start, then after each of the two heartbeats
        self.assertEqual(len(alive), 1 + sum(1 for line in emitted if 'heartbeat' in line))
        self.assertEqual((alive[0], len(alive)), (0.0, 3))

    def test_cli_streams_json_lines(self):
        self.write('20261009', line(1), line(2))
        proc = subprocess.Popen([sys.executable, '-c', 'import sys; from luady_kit.ctl import main; sys.exit(main())',
                                 'tail-events', '--from', 'start'], cwd=str(KIT_ROOT),
                                env={**os.environ, 'HOME': str(self.home)}, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE)
        try:
            first = json.loads(proc.stdout.readline())
            second = json.loads(proc.stdout.readline())
        finally:
            proc.kill()
            proc.wait()
            proc.stdout.close()
        self.assertEqual(set(first), {'file', 'offset', 'event'})
        self.assertEqual((first['file'], first['event']['n'], second['event']['n']), ('events-20261009.jsonl', 1, 2))
        self.assertTrue(self.paths.tail_alive.is_file())


if __name__ == '__main__':
    unittest.main()
