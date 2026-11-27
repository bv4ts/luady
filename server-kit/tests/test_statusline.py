"""The status-line script: meters from the status JSON, change-based forwarding, the short line and chaining."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from luady_kit import common, hook, statusline
from luady_kit.common import RunResult
from luady_kit.tmuxio import Tmux
from tests.helpers import HomeTestCase

KIT_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = KIT_ROOT / 'tests' / 'fixtures' / 's4'
NOW = datetime(2026, 11, 14, 9, 30, 0, tzinfo=timezone.utc)
METER_KEYS = {'context_pct', 'model', 'cost_usd', 'five_hour', 'seven_day'}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f'statusline-{name}.json').read_text(encoding='utf-8'))


def meters(**overrides):
    base = {'context_pct': 41.2, 'model': 'Opus', 'cost_usd': 1.5,
            'five_hour': {'used_pct': 12, 'resets_at': '2026-11-14T12:00:00Z'},
            'seven_day': {'used_pct': 30, 'resets_at': '2026-11-20T00:00:00Z'}}
    return {**base, **overrides}


class ReadMetersTest(unittest.TestCase):
    def test_team_fixture_has_both_windows(self):
        out = statusline.read_meters(fixture('team'))
        self.assertEqual(set(out), METER_KEYS)
        self.assertEqual((out['context_pct'], out['model']), (5, 'Haiku 5.5'))
        self.assertAlmostEqual(out['cost_usd'], 0.00436924)
        self.assertEqual(out['five_hour'], {'used_pct': 26, 'resets_at': '2026-11-13T23:10:00Z'})
        self.assertEqual(out['seven_day']['used_pct'], 90)

    def test_max_fixture_misses_the_five_hour_window(self):
        out = statusline.read_meters(fixture('max'))
        self.assertEqual(set(out), METER_KEYS)
        self.assertIsNone(out['five_hour'])
        self.assertEqual(out['seven_day']['used_pct'], 47)
        self.assertTrue(0 <= out['context_pct'] <= 100)

    def test_first_call_before_any_reply(self):
        payload = {**fixture('team'), 'context_window': {'used_percentage': None}}
        del payload['rate_limits']
        out = statusline.read_meters(payload)
        self.assertEqual((out['context_pct'], out['five_hour'], out['seven_day']), (None, None, None))

    def test_values_are_converted_and_checked(self):
        payload = {'model': {'id': 'claude-x'}, 'context_window': {'used_percentage': 140},
                   'cost': {'total_cost_usd': 'free'},
                   'rate_limits': {'five_hour': {'used_percentage': -3, 'resets_at': 1767225600},
                                   'seven_day': {'used_percentage': True, 'resets_at': 1767225600}}}
        out = statusline.read_meters(payload)
        self.assertEqual(out, {'context_pct': 100, 'model': 'claude-x', 'cost_usd': None,
                               'five_hour': {'used_pct': 0, 'resets_at': '2026-01-01T00:00:00Z'}, 'seven_day': None})
        self.assertIsNone(statusline.read_meters({'rate_limits': {'five_hour': {'used_percentage': 5,
                                                                                'resets_at': 1e30}}})['five_hour'])
        self.assertEqual(statusline.read_meters({'model': 'x' * 100})['model'][-1], '…')
        self.assertEqual(statusline.read_meters([]), {key: None for key in METER_KEYS})


class ForwardTest(unittest.TestCase):
    def test_rules(self):
        t = 1000.0
        prev = {**meters(), 'sent_at': t}
        self.assertTrue(statusline.should_forward(None, meters(), t))
        self.assertFalse(statusline.should_forward(prev, meters(), t + 10))
        self.assertFalse(statusline.should_forward(prev, meters(context_pct=41.9), t + 10))
        self.assertTrue(statusline.should_forward(prev, meters(context_pct=42.0), t + 10))
        self.assertTrue(statusline.should_forward({**prev, 'five_hour': None}, meters(), t + 10))
        self.assertTrue(statusline.should_forward(prev, meters(five_hour=None), t + 10))
        self.assertTrue(statusline.should_forward(prev, meters(model='Sonnet'), t + 10))
        later = meters(seven_day={'used_pct': 30, 'resets_at': '2026-11-27T00:00:00Z'})
        self.assertTrue(statusline.should_forward(prev, later, t + 10))
        self.assertFalse(statusline.should_forward(prev, meters(cost_usd=2.0), t + 59))
        self.assertTrue(statusline.should_forward(prev, meters(cost_usd=2.0), t + 60))
        self.assertFalse(statusline.should_forward(prev, meters(), t + 300))
        self.assertTrue(statusline.should_forward({'context_pct': 41.2}, meters(cost_usd=2.0), t))


class ShortLineTest(unittest.TestCase):
    def test_full_and_partial(self):
        self.assertEqual(statusline.short_line(meters()), 'Opus · ctx 41% · 5h 12% · 7d 30%')
        self.assertEqual(statusline.short_line(meters(five_hour=None, seven_day=None, context_pct=7.6)), 'Opus · ctx 8%')
        self.assertEqual(statusline.short_line({key: None for key in METER_KEYS}), 'Claude')


class StatusLineMainTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='birch')
        self.now = NOW
        self.tmux_calls = []

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            self.tmux_calls.append(argv)
            return RunResult(0, b'cc-pane:0.0\t1', b'')
        self.env = hook.HookEnv(paths=self.paths, tmux=Tmux(run), environ={'TMUX_PANE': '%2'}, now=lambda: self.now)

    def run_main(self, payload):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        out = io.BytesIO()
        self.assertEqual(statusline.main(stdin=io.BytesIO(raw), stdout=out, env=self.env), 0)
        return out.getvalue().decode('utf-8')

    def chain(self, command):
        common.atomic_write_json(self.paths.statusline_chain, {'type': 'command', 'command': command, 'padding': 0})

    def test_prints_the_short_line_and_spools_on_change_only(self):
        common.write_registry(self.paths, {'session_id': 'SESSION_ID', 'tmux': 'cc-app:0.0', 'started_at': 'x'})
        self.assertEqual(self.run_main(fixture('team')), 'Haiku 5.5 · ctx 5% · 5h 26% · 7d 90%')
        (event,) = self.spool_events()
        self.assertEqual((event['event'], event['tmux'], event['host'], event['session_id']),
                         ('meters', 'cc-pane:0.0', 'birch', 'SESSION_ID'))
        self.assertEqual(set(event['data']), METER_KEYS)
        self.assertEqual(len(self.tmux_calls), 1)  # the live pane, not the target SessionStart saw
        saved = common.read_json_or_none(self.paths.meters / 'SESSION_ID.json')
        self.assertEqual(saved['sent_at'], NOW.timestamp())
        self.assertEqual(self.run_main(fixture('team')), 'Haiku 5.5 · ctx 5% · 5h 26% · 7d 90%')
        self.assertEqual(len(self.spool_events()), 1)
        self.now = NOW + timedelta(seconds=61)
        self.run_main({**fixture('team'), 'cost': {'total_cost_usd': 0.5}})
        self.assertEqual(len(self.spool_events()), 2)

    def test_unregistered_session_asks_tmux(self):
        self.run_main(fixture('max'))
        self.assertEqual(self.spool_events()[0]['tmux'], 'cc-pane:0.0')
        self.assertEqual(len(self.tmux_calls), 1)

    def test_chained_status_line_is_printed_instead(self):
        self.chain(f'cat > "{self.home}/chain-input.json"; printf custom')
        self.assertEqual(self.run_main(fixture('team')), 'custom')
        self.assertEqual(json.loads((self.home / 'chain-input.json').read_text(encoding='utf-8')), fixture('team'))
        self.assertEqual(len(self.spool_events()), 1)

    def test_slow_chain_is_cut_at_two_seconds(self):
        self.chain('sleep 10; printf late')
        started = time.monotonic()
        self.assertEqual(self.run_main(fixture('team')), 'Haiku 5.5 · ctx 5% · 5h 26% · 7d 90%')
        self.assertLess(time.monotonic() - started, 5)

    def test_failing_chain_without_output_falls_back(self):
        self.chain('exit 3')
        self.assertEqual(self.run_main(fixture('max')), 'Haiku 5.5 · ctx 4% · 7d 47%')

    def test_invalid_input(self):
        self.assertEqual(self.run_main(b'not json'), 'Claude')
        self.assertEqual(self.spool_events(), [])
        self.assertEqual(self.run_main({**fixture('team'), 'session_id': '../x'}), 'Haiku 5.5 · ctx 5% · 5h 26% · 7d 90%')
        self.assertEqual(self.spool_events(), [])
        self.assertFalse((self.paths.state / 'x.json').exists())
        self.assertEqual(list(self.paths.meters.glob('*')) if self.paths.meters.exists() else [], [])

    def test_spool_problems_never_blank_the_line(self):
        self.paths.spool.rmdir()
        self.paths.spool.write_text('not a directory', encoding='utf-8')
        self.assertEqual(self.run_main(fixture('team')), 'Haiku 5.5 · ctx 5% · 5h 26% · 7d 90%')
        self.assertIn('status line failed', self.paths.hook_errors.read_text(encoding='utf-8'))

    def test_hourly_cleanup_purges_old_meter_files(self):
        self.paths.meters.mkdir(parents=True)
        old, fresh = self.paths.meters / 'a.json', self.paths.meters / 'b.json'
        for path, age in ((old, 31 * 86400), (fresh, 60)):
            path.write_text('{}', encoding='utf-8')
            os.utime(path, (NOW.timestamp() - age, NOW.timestamp() - age))
        hook.run_cleanup(self.env, common.load_config(self.paths))
        self.assertEqual(sorted(p.name for p in self.paths.meters.iterdir()), ['b.json'])

    def test_shim_prints_the_line(self):
        env = {k: v for k, v in os.environ.items() if k != 'TMUX_PANE'}
        result = subprocess.run([sys.executable, str(KIT_ROOT / 'hooks' / 'luady_statusline.py')],
                                input=json.dumps(fixture('max')).encode(), env={**env, 'HOME': str(self.home)},
                                capture_output=True, timeout=20)
        self.assertEqual((result.returncode, result.stdout.decode()), (0, 'Haiku 5.5 · ctx 4% · 7d 47%'))


if __name__ == '__main__':
    unittest.main()
