"""Unit tests for luady_kit.common: prompt hash and limits, ids, time, atomic files, spool, config and stores."""
from __future__ import annotations

import json
import multiprocessing
import os
import stat
import subprocess
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from luady_kit import common
from tests.helpers import HomeTestCase, read_spool

MOMENT = datetime(2026, 10, 9, 19, 42, 11, 123456, tzinfo=timezone.utc)


def _append_worker(path: str, worker: int, count: int) -> None:
    for index in range(count):
        line = json.dumps({'worker': worker, 'index': index, 'pad': 'x' * 3000}) + '\n'
        common.append_line_locked(Path(path), line.encode('utf-8'))


class TextTest(unittest.TestCase):
    def test_prompt_hash_matches_c1_vectors(self):
        self.assertEqual(common.prompt_hash('  hello\r\nworld \n'),
                         '26c60a61d01db5836ca70fefd44a6a016620413c8ef5f259a6c5612d4f79d3b8')
        self.assertEqual(common.prompt_hash('\t\u0645\u0631\u062d\u0628\u0627 \U0001f680\r\n'),
                         'bec5d72abb826a4bf655f5fbd873b6b7297265c4460b79389a06aff5d0e9bea7')
        self.assertEqual(common.prompt_hash('line one\r\nline two\n\n'),
                         'b6858b03a6cae635deeaeab09a74e598979b72c917cbfff0bb3fe2cd05111dbc')

    def test_prompt_hash_keeps_non_breaking_space(self):
        self.assertEqual(common.prompt_hash('\u00a0x\u00a0'),
                         'b1a662098f1491da4af17ec6842fd8ba694312b2a2906f0e356f7289202f0669')

    def test_prompt_hash_of_blank_text_is_hash_of_empty_string(self):
        self.assertEqual(common.prompt_hash(' \n\t '),
                         'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

    def test_lone_surrogate_hashes_like_replacement_char(self):
        self.assertEqual(common.prompt_hash('a\ud83d'), common.prompt_hash('a\ufffd'))

    def test_truncate_chars_counts_characters_and_adds_ellipsis(self):
        self.assertEqual(common.truncate_chars('abc', 3), ('abc', False))
        self.assertEqual(common.truncate_chars('abcd', 3), ('ab\u2026', True))
        self.assertEqual(common.truncate_chars('\U0001f680' * 10, 5), ('\U0001f680' * 4 + '\u2026', True))

    def test_truncate_rejects_zero_limit(self):
        with self.assertRaises(ValueError):
            common.truncate_chars('x', 0)

    def test_matches_uses_fullmatch_and_ascii_digits(self):
        self.assertTrue(common.matches(common.QID_RE, 'ABCDEFG2'))
        self.assertFalse(common.matches(common.QID_RE, 'ABCDEFG2\n'))
        self.assertTrue(common.matches(common.TARGET_RE, 'cc-app:0.0'))
        self.assertFalse(common.matches(common.TARGET_RE, 'cc-a:\u0661.0'))
        self.assertFalse(common.matches(common.NAME_RE, None))
        self.assertFalse(common.matches(common.SID_RE, '..'))

    def test_ctl_error_codes(self):
        self.assertEqual(common.CtlError('refused', 'no').code, 'refused')
        with self.assertRaises(ValueError):
            common.CtlError('ok', 'not an error code')


class IdsAndTimeTest(unittest.TestCase):
    def test_qid_alphabet_and_length(self):
        qids = {common.new_qid() for _ in range(500)}
        self.assertTrue(all(common.matches(common.QID_RE, q) for q in qids))
        self.assertGreater(len(qids), 490)

    def test_event_id_is_uuid4(self):
        self.assertRegex(common.new_event_id(),
                         r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')

    def test_iso_utc_has_milliseconds_and_z(self):
        self.assertEqual(common.iso_utc(MOMENT), '2026-10-09T19:42:11.123Z')
        self.assertEqual(common.iso_utc(MOMENT.astimezone(timezone(timedelta(hours=4)))), '2026-10-09T19:42:11.123Z')

    def test_day_and_compact_stamp(self):
        self.assertEqual(common.utc_day(MOMENT), '20261009')
        self.assertEqual(common.compact_stamp(MOMENT), '20261009T194211123Z')


class PathsTest(unittest.TestCase):
    def test_layout_under_home(self):
        paths = common.KitPaths(Path('/home/dev'))
        self.assertEqual(paths.root, Path('/home/dev/.luady'))
        self.assertEqual(paths.lib, Path('/home/dev/.luady/lib'))
        self.assertEqual(paths.config_file, Path('/home/dev/.luady/state/config.json'))
        self.assertEqual(paths.hook_errors, Path('/home/dev/.luady/state/hook-errors.log'))
        self.assertEqual(paths.claude_bin, Path('/home/dev/.local/bin/claude'))
        self.assertEqual(paths.claude_projects, Path('/home/dev/.claude/projects'))
        self.assertEqual(paths.claude_settings, Path('/home/dev/.claude/settings.json'))

    def test_from_env_uses_home(self):
        self.assertEqual(common.KitPaths.from_env({'HOME': '/tmp/h'}).root, Path('/tmp/h/.luady'))
        self.assertEqual(common.KitPaths.from_env({'HOME': '/tmp/h'}).claude_bin, Path('/tmp/h/.local/bin/claude'))

    def test_claude_bin_override(self):
        paths = common.KitPaths(Path('/home/dev'), claude_bin_override=Path('/opt/claude/bin/claude'))
        self.assertEqual(paths.claude_bin, Path('/opt/claude/bin/claude'))
        self.assertEqual(paths.config_file, Path('/home/dev/.luady/state/config.json'))
        with self.assertRaises(AttributeError):
            paths.claude_bin_override = None  # still frozen
        configured = common.configured_paths(Path('/home/dev'), {'claude_bin': '/opt/claude/bin/claude'})
        self.assertEqual(configured, paths)
        for config in ({}, {'claude_bin': None}, {'claude_bin': 'claude'}, {'claude_bin': '/opt/../claude'}):
            with self.subTest(config=config):
                self.assertEqual(common.configured_paths(Path('/home/dev'), config).claude_bin,
                                 Path('/home/dev/.local/bin/claude'))

    def test_normalize_abs_path(self):
        self.assertEqual(common.normalize_abs_path('/a/b/../c//d/'), '/a/c/d')
        self.assertEqual(common.normalize_abs_path('//etc/shadow'), '/etc/shadow')
        for bad in ('relative/x', '', '/a\nb', '/a\x00b'):
            with self.assertRaises(common.CtlError) as caught:
                common.normalize_abs_path(bad)
            self.assertEqual(caught.exception.code, 'usage')


class FilesTest(HomeTestCase):
    def test_atomic_write_json_replaces_and_sets_mode(self):
        target = self.home / 'x.json'
        common.atomic_write_json(target, {'a': 1})
        common.atomic_write_json(target, {'a': '\u0645'})
        self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'a': '\u0645'})
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual([p.name for p in self.home.iterdir() if p.name.endswith('.tmp')], [])

    def test_exclusive_write_refuses_existing(self):
        target = self.home / 'once.json'
        self.assertTrue(common.exclusive_write_json(target, {'n': 1}))
        self.assertFalse(common.exclusive_write_json(target, {'n': 2}))
        self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'n': 1})
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ['.luady', 'once.json'])

    def test_read_json_or_none(self):
        bad = self.home / 'bad.json'
        bad.write_text('{nope', encoding='utf-8')
        self.assertIsNone(common.read_json_or_none(bad))
        self.assertIsNone(common.read_json_or_none(self.home / 'missing.json'))

    def test_concurrent_appends_never_interleave(self):
        target = self.home / 'spool.jsonl'
        context = multiprocessing.get_context('fork')
        workers = [context.Process(target=_append_worker, args=(str(target), w, 150)) for w in range(6)]
        for proc in workers:
            proc.start()
        for proc in workers:
            proc.join(60)
        lines = target.read_text(encoding='utf-8').splitlines()
        self.assertEqual(len(lines), 900)
        seen = {(item['worker'], item['index']) for item in map(json.loads, lines)}
        self.assertEqual(seen, {(w, i) for w in range(6) for i in range(150)})


class SpoolAndConfigTest(HomeTestCase):
    def test_build_record_and_append_event(self):
        meta = {'session_id': 's1', 'cwd': '/w', 'transcript_path': '/t.jsonl', 'tmux': 'cc-a:0.0', 'permission_mode': 7}
        record = common.build_record('stop', 'cedar', meta, {'last_assistant_message': 'hi', 'truncated': False}, MOMENT)
        common.append_event(self.paths, record)
        self.assertTrue((self.paths.spool / 'events-20261009.jsonl').exists())
        [event] = read_spool(self.paths)
        self.assertEqual(set(event), {'v', 'id', 'ts', 'host', 'event', 'session_id', 'cwd', 'transcript_path',
                                      'tmux', 'permission_mode', 'data'})
        self.assertEqual((event['v'], event['ts'], event['host'], event['event']), (1, '2026-10-09T19:42:11.123Z', 'cedar', 'stop'))
        self.assertIsNone(event['permission_mode'])

    def test_load_config_defaults_and_invalid_values(self):
        config = common.load_config(self.paths)
        self.assertEqual((config['remote_answering'], config['hook_wait_seconds']), (True, 14400))
        self.assertTrue(common.matches(common.HOST_ALIAS_RE, config['host_alias']))
        common.atomic_write_json(self.paths.config_file,
                                 {'remote_answering': 'yes', 'hook_wait_seconds': 999999, 'host_alias': 'bad alias'})
        config = common.load_config(self.paths)
        self.assertEqual((config['remote_answering'], config['hook_wait_seconds']), (True, 14400))
        self.assertNotEqual(config['host_alias'], 'bad alias')

    def test_load_config_keeps_valid_values(self):
        self.write_config(remote_answering=False, hook_wait_seconds=60, host_alias='cedar')
        self.assertEqual(common.load_config(self.paths),
                         {'remote_answering': False, 'hook_wait_seconds': 60, 'host_alias': 'cedar',
                          'projects_root': common.default_projects_root(self.paths.home), 'claude_bin': None})

    def test_load_config_returns_the_stored_paths(self):
        self.write_config(host_alias='ash', projects_root='/srv/projects', claude_bin='/opt/claude/bin/claude')
        config = common.load_config(self.paths)
        self.assertEqual((config['projects_root'], config['claude_bin']), ('/srv/projects', '/opt/claude/bin/claude'))

    def test_load_config_path_defaults_for_missing_or_invalid_values(self):
        self.write_config(host_alias='ash')
        config = common.load_config(self.paths)
        self.assertEqual((config['projects_root'], config['claude_bin']), (common.default_projects_root(self.paths.home), None))
        for bad in ('srv/projects', '/srv/../etc', '/srv/a;b', '/srv/my projects', '/srv/x\n', '/' + 'a' * 256, '/',
                    '', 7, None, ['/srv'], '/srv/م'):
            with self.subTest(value=bad):
                self.write_config(host_alias='ash', projects_root=bad, claude_bin=bad)
                config = common.load_config(self.paths)
                self.assertEqual((config['projects_root'], config['claude_bin']), (common.default_projects_root(self.paths.home), None))

    def test_path_setting_rule_edges(self):
        self.assertTrue(common.matches(common.PATH_SETTING_RE, '/' + 'a' * 255))
        self.assertFalse(common.matches(common.PATH_SETTING_RE, '/' + 'a' * 256))
        self.assertTrue(common.matches(common.PATH_SETTING_RE, '/home/dev/my.projects_2-x/'))
        self.assertFalse(common.matches(common.PATH_SETTING_RE, '/srv/a..b'))

    def test_config_for_file_writes_only_the_given_path_settings(self):
        config = {**common.default_config('ash'), 'projects_root': common.default_projects_root(self.paths.home), 'claude_bin': None}
        self.assertEqual(common.config_for_file(config, {}), common.default_config('ash'))
        self.assertEqual(common.config_for_file(config, {'claude_bin': '/opt/claude/bin/claude'}),
                         {**common.default_config('ash'), 'claude_bin': '/opt/claude/bin/claude'})
        self.assertEqual(common.stored_path_settings(['not', 'an', 'object']), {})

    def test_log_hook_error_never_raises(self):
        common.log_hook_error(self.paths, 'first\nline')
        self.assertIn('first line', self.paths.hook_errors.read_text(encoding='utf-8'))
        (self.home / 'file-not-dir').write_text('x', encoding='utf-8')
        common.log_hook_error(common.KitPaths(self.home / 'file-not-dir'), 'ignored')


class FullDiskTest(HomeTestCase):
    """A failed or partial append leaves the spool exactly as it was, so the next line starts clean."""

    def test_a_partial_append_is_undone(self):
        path = self.paths.spool / 'events-20261114.jsonl'
        common.append_line_locked(path, b'{"first": 1}\n')
        real_write = os.write
        calls = []

        def write_half_then_fail(fd, data):
            calls.append(len(data))
            if len(calls) == 1:
                return real_write(fd, bytes(data[:5]))
            raise OSError(28, 'No space left on device')

        with mock.patch.object(common.os, 'write', write_half_then_fail):
            with self.assertRaises(OSError):
                common.append_line_locked(path, b'{"second": 2}\n')
        self.assertEqual(path.read_bytes(), b'{"first": 1}\n')
        common.append_line_locked(path, b'{"third": 3}\n')
        self.assertEqual([json.loads(line) for line in path.read_bytes().splitlines()], [{'first': 1}, {'third': 3}])

    def test_the_hook_still_exits_zero_on_a_full_disk(self):
        import io

        from luady_kit import hook
        self.write_config(host_alias='cedar')
        env = hook.HookEnv(paths=self.paths, tmux=hook.Tmux(lambda *a, **k: common.RunResult(1, b'', b'')), environ={})
        with mock.patch.object(common.os, 'write', side_effect=OSError(28, 'No space left on device')):
            code = hook.main(stdin=io.BytesIO(b'{"hook_event_name": "Stop", "session_id": "s"}'), stdout=io.BytesIO(),
                             env=env)
        self.assertEqual(code, 0)
        self.assertEqual(read_spool(self.paths), [])


class RunProcessTest(unittest.TestCase):
    def test_runs_without_shell_and_passes_stdin(self):
        result = common.run_process(['cat'], input_bytes='$(echo x) \u0645'.encode('utf-8'))
        self.assertEqual((result.code, result.text), (0, '$(echo x) \u0645'))

    def test_missing_binary_and_timeout(self):
        self.assertEqual(common.run_process(['/nonexistent/bin']).code, 127)
        slow = common.run_process(['sleep', '5'], timeout=0.2)
        self.assertEqual((slow.code, slow.timed_out), (124, True))


class PendingStoreTest(HomeTestCase):
    def _pending(self, qid, kind='question', pid=None, start=None):
        own = os.getpid()
        entry = {'qid': qid, 'kind': kind, 'created_at': '2026-10-09T10:00:00.000Z', 'session_id': 's',
                 'tmux': 'cc-a:0.0', 'payload': {}, 'meta': {'session_id': 's', 'tmux': 'cc-a:0.0'},
                 'pid': own if pid is None else pid,
                 'pid_start': common.proc_start_ticks(own) if start is None else start}
        common.atomic_write_json(common.pending_path(self.paths, qid), entry)
        return entry

    def test_live_entries_are_kept(self):
        self._pending('AAAAAAAA')
        self.assertEqual([e['qid'] for e in common.live_pending(self.paths, 'cedar', MOMENT)], ['AAAAAAAA'])
        self.assertEqual(read_spool(self.paths), [])

    def test_dead_waiter_is_reaped_with_error_event(self):
        dead = subprocess.Popen(['true'])
        dead.wait()
        self._pending('BBBBBBBB', kind='permission', pid=dead.pid, start=1)
        common.atomic_write_json(common.answer_path(self.paths, 'BBBBBBBB'), {'release': True})
        self.assertEqual(common.live_pending(self.paths, 'cedar', MOMENT), [])
        [event] = read_spool(self.paths)
        self.assertEqual((event['event'], event['data']), ('permission_resolved', {'qid': 'BBBBBBBB', 'outcome': 'error'}))
        self.assertEqual(event['tmux'], 'cc-a:0.0')
        self.assertFalse(common.answer_path(self.paths, 'BBBBBBBB').exists())

    def test_reused_pid_with_other_start_time_counts_as_dead(self):
        self._pending('CCCCCCCC', start=-5)
        self.assertEqual(common.reap_dead_pending(self.paths, 'cedar', MOMENT), ['CCCCCCCC'])

    def test_claim_is_exclusive(self):
        self._pending('DDDDDDDD')
        self.assertTrue(common.claim_pending(self.paths, 'DDDDDDDD'))
        self.assertFalse(common.claim_pending(self.paths, 'DDDDDDDD'))

    def test_malformed_pending_files_are_ignored(self):
        common.pending_path(self.paths, 'EEEEEEEE').write_text('{"qid": "XXXXXXXX", "kind": "question"}')
        (self.paths.pending / 'junk.json').write_text('nope', encoding='utf-8')
        self.assertEqual(common.list_pending(self.paths), [])


class RegistryTest(HomeTestCase):
    def test_write_read_list_remove(self):
        entry = {'session_id': 'abc-1', 'transcript_path': '/t', 'cwd': '/w', 'tmux': 'cc-a:0.0',
                 'source': 'startup', 'started_at': '2026-10-09T10:00:00.000Z', 'pane_pid': 10}
        common.write_registry(self.paths, entry)
        self.assertEqual(common.read_registry(self.paths, 'abc-1'), entry)
        self.assertEqual(common.list_registry(self.paths), [entry])
        common.remove_registry(self.paths, 'abc-1')
        common.remove_registry(self.paths, 'abc-1')
        self.assertEqual(common.list_registry(self.paths), [])

    def test_registry_for_target_prefers_newest_matching_pane(self):
        old = {'session_id': 'a', 'tmux': 'cc-a:0.0', 'started_at': '2026-10-09T10:00:00.000Z', 'pane_pid': 10}
        new = {'session_id': 'b', 'tmux': 'cc-a:0.0', 'started_at': '2026-10-09T11:00:00.000Z', 'pane_pid': 10}
        other = {'session_id': 'c', 'tmux': 'cc-a:0.0', 'started_at': '2026-10-09T12:00:00.000Z', 'pane_pid': 99}
        entries = [old, new, other]
        self.assertEqual(common.registry_for_target(entries, 'cc-a:0.0', 10), new)
        self.assertEqual(common.registry_for_target(entries, 'cc-a:0.0', None), other)
        self.assertIsNone(common.registry_for_target(entries, 'cc-b:0.0', 10))


class HubListeningTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.proc = self.home / 'proc'
        self.proc.mkdir()

    def process(self, pid, *argv):
        (self.proc / str(pid)).mkdir()
        (self.proc / str(pid) / 'cmdline').write_bytes(b'\0'.join(arg.encode() for arg in argv) + b'\0')

    def test_fresh_stale_and_missing(self):
        now = time.time()
        self.assertFalse(common.hub_listening(self.paths, now, str(self.proc)))
        common.touch_tail_alive(self.paths, now - 10)
        self.assertTrue(common.hub_listening(self.paths, now, str(self.proc)))
        self.assertEqual(stat.S_IMODE(self.paths.tail_alive.stat().st_mode), 0o600)
        common.touch_tail_alive(self.paths, now - common.HUB_LISTEN_STALE_SECONDS - 1)
        self.assertFalse(common.hub_listening(self.paths, now, str(self.proc)))
        self.process(77, 'python3', '/home/dev/.luady/bin/luady-ctl', 'tail-events', '--from', 'end')
        self.assertFalse(common.hub_listening(self.paths, now, str(self.proc)))  # a stale file is not saved by it

    def test_a_file_dated_in_the_future_counts_as_stale(self):
        now = time.time()
        for ahead, listening in ((10 * 365 * 86400, False), (common.HUB_LISTEN_FUTURE_SECONDS + 5, False), (30, True)):
            with self.subTest(ahead=ahead):
                common.touch_tail_alive(self.paths, now + ahead)
                self.assertIs(common.hub_listening(self.paths, now, str(self.proc)), listening)

    def test_with_no_file_only_a_running_tail_events_counts(self):
        self.process(10, 'tail', '-f', 'tail-events')
        self.process(11, 'python3', '/home/dev/.luady/bin/luady-ctl', 'sessions')
        self.assertFalse(common.tail_events_running(str(self.proc)))
        self.process(12, '/usr/bin/python3', '/home/dev/.luady/bin/luady-ctl', 'tail-events', '--from', 'start')
        self.assertTrue(common.tail_events_running(str(self.proc)))
        self.assertTrue(common.hub_listening(self.paths, time.time(), str(self.proc)))
        self.assertFalse(common.tail_events_running(str(self.home / 'missing')))


if __name__ == '__main__':
    unittest.main()
