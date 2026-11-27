"""Pause and resume: the per-pane flag, the shell pause check inside a pane, the hit marker and the resume verb."""
from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

from luady_kit import common, hook, pause
from luady_kit.common import RunResult
from luady_kit.tmuxio import Tmux
from tests.ctl_helpers import fast_ctx, run_ctl
from tests.helpers import HomeTestCase, wait_until
from tests.tmux_helpers import TmuxTestCase, fake_log, install_kit_hooks, submits, tmux, wait_for_event

KIT_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = KIT_ROOT / 'hooks' / 'luady_pause.sh'
NOW = datetime(2026, 11, 14, 9, 30, 0, tzinfo=timezone.utc)


def write_flag(paths: common.KitPaths, name: str, target: str = 'cc-x:0.0', hit: bool = False) -> Path:
    paths.pause.mkdir(parents=True, exist_ok=True)
    path = paths.pause / name
    common.atomic_write_json(path, {'target': target, 'at': '2026-11-14T09:00:00.000Z', 'hit': hit})
    return path


class PauseUnitTest(HomeTestCase):
    def run_script(self, env_extra, path_prefix=None):
        env = {'HOME': str(self.home), 'PATH': os.environ['PATH'], **env_extra}
        if path_prefix:
            env['PATH'] = f'{path_prefix}:{env["PATH"]}'
        return subprocess.run(['sh', str(SCRIPT)], input=b'{}', env=env, capture_output=True, timeout=10)

    def fake_python(self):
        bin_dir = Path(tempfile.mkdtemp(dir=self.home))
        marker = self.home / 'python-ran'
        (bin_dir / 'python3').write_text(f'#!/bin/sh\ntouch {marker}\n', encoding='ascii')
        (bin_dir / 'python3').chmod(0o755)
        return bin_dir, marker

    def test_flag_name(self):
        self.assertEqual(pause.flag_name('4242', '%7'), '4242-7')
        self.assertEqual(pause.flag_name('1', '12'), '1-12')

    def test_constants(self):
        self.assertEqual(json.loads(pause.STOP_OUTPUT), {'continue': False, 'stopReason': 'Paused by the owner'})
        self.assertEqual(pause.RESUME_TEXT, 'The owner has lifted the pause. Continue from where you paused.')
        self.assertIn(pause.STOP_OUTPUT, SCRIPT.read_text(encoding='utf-8'))

    def test_outside_tmux_the_check_exits_zero_silently(self):
        write_flag(self.paths, '123-4')
        result = self.run_script({'TMUX': '/tmp/t,123,0'})
        self.assertEqual((result.returncode, result.stdout), (0, b''))

    def test_the_check_is_inert_without_home_kit_or_python(self):
        bin_dir, marker = self.fake_python()
        write_flag(self.paths, '123-4')
        env = {'TMUX': '/tmp/tmux-1/default,123,0', 'TMUX_PANE': '%4'}
        without_kit = self.run_script(env, bin_dir)
        install_kit_hooks(self.home)
        (self.paths.lib / 'luady_kit').unlink()
        without_lib = self.run_script(env, bin_dir)
        no_home = subprocess.run(['sh', str(SCRIPT)], input=b'{}', capture_output=True, timeout=10,
                                 env={'PATH': f'{bin_dir}:{os.environ["PATH"]}', **env})
        for result in (without_kit, without_lib, no_home):
            self.assertEqual((result.returncode, result.stdout), (0, b''))
        self.assertFalse(marker.exists())
        (self.paths.lib / 'luady_kit').symlink_to(KIT_ROOT / 'luady_kit', target_is_directory=True)
        only_sh = self.home / 'only-sh'
        only_sh.mkdir()
        no_python = subprocess.run(['/bin/sh', str(SCRIPT)], input=b'{}', capture_output=True, timeout=10,
                                   env={'HOME': str(self.home), 'PATH': str(only_sh), **env})
        self.assertEqual((no_python.returncode, no_python.stdout), (0, b''))

    def test_no_flag_never_starts_python(self):
        install_kit_hooks(self.home)
        bin_dir, marker = self.fake_python()
        env = {'TMUX': '/tmp/tmux-1/default,123,0', 'TMUX_PANE': '%4'}
        empty = self.run_script(env, bin_dir)
        write_flag(self.paths, '123-5')
        other_pane = self.run_script(env, bin_dir)
        write_flag(self.paths, '999-4')
        other_server = self.run_script(env, bin_dir)
        for result in (empty, other_pane, other_server):
            self.assertEqual((result.returncode, result.stdout), (0, b''))
        self.assertFalse(marker.exists())
        write_flag(self.paths, '123-4')
        hit = self.run_script(env, bin_dir)
        self.assertEqual((hit.returncode, hit.stdout.decode()), (0, pause.STOP_OUTPUT))
        self.assertTrue(marker.exists(), 'the fake python3 must run on a hit, else this test proves nothing')

    def test_missing_pause_directory(self):
        self.paths.pause.rmdir()
        result = self.run_script({'TMUX': '/tmp/t,1,0', 'TMUX_PANE': '%1'})
        self.assertEqual((result.returncode, result.stdout), (0, b''))

    def test_the_no_flag_path_is_fast(self):
        write_flag(self.paths, '123-5')
        env = {'HOME': str(self.home), 'PATH': os.environ['PATH'], 'TMUX': '/tmp/t,123,0', 'TMUX_PANE': '%4'}
        started = time.monotonic()
        for _ in range(200):
            subprocess.run(['sh', str(SCRIPT)], env=env, stdin=subprocess.DEVNULL, capture_output=True, check=True)
        self.assertLess(time.monotonic() - started, 5.0)

    def test_hit_marks_the_flag_and_spools_one_paused_event(self):
        self.write_config(host_alias='cedar')
        flag = write_flag(self.paths, '123-4', target='cc-app:0.0')
        payload = {'session_id': 'sess-1', 'cwd': '/w', 'transcript_path': '/t.jsonl', 'permission_mode': 'default',
                   'hook_event_name': 'PostToolUse', 'tool_name': 'Bash'}
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(lambda *a, **k: RunResult(0, b'cc-app:0.0\t42', b'')),
                           environ={'TMUX_PANE': '%4', 'TMUX': '/tmp/t,123,0'}, now=lambda: NOW)
        self.assertEqual(pause.hit_main(str(flag), stdin=io.BytesIO(json.dumps(payload).encode()), env=env), 0)
        self.assertTrue(common.read_json_or_none(flag)['hit'])
        (event,) = self.spool_events()
        self.assertEqual((event['event'], event['data'], event['tmux'], event['session_id'], event['host']),
                         ('paused', {}, 'cc-app:0.0', 'sess-1', 'cedar'))
        pause.hit_main(str(flag), stdin=io.BytesIO(b'not json'), env=env)
        self.assertEqual(len(self.spool_events()), 2)

    def test_a_failed_call_never_marks_a_hit_or_spools_paused(self):
        # Claude Code ignores a stop from PostToolUseFailure, so it is not a hit.
        flag = write_flag(self.paths, '123-4', target='cc-app:0.0')
        failure = (KIT_ROOT / 'tests' / 'fixtures' / 's3' / 'PostToolUseFailure-pause.json').read_bytes()
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(lambda *a, **k: RunResult(1, b'', b'')), environ={}, now=lambda: NOW)
        self.assertEqual(pause.hit_main(str(flag), stdin=io.BytesIO(failure), env=env), 0)
        self.assertFalse(common.read_json_or_none(flag)['hit'])
        self.assertEqual(self.spool_events(), [])

    def test_hit_after_a_resume_reports_the_stop_but_never_recreates_the_flag(self):
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(lambda *a, **k: RunResult(1, b'', b'')), environ={}, now=lambda: NOW)
        pause.hit_main(str(self.paths.pause / '123-4'), stdin=io.BytesIO(b'{"session_id": "s"}'), env=env)
        self.assertFalse((self.paths.pause / '123-4').exists())
        self.assertEqual([e['event'] for e in self.spool_events()], ['paused'])

    def test_hit_with_a_path_that_is_not_a_flag_is_logged(self):
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(), environ={}, now=lambda: NOW)
        self.assertEqual(pause.hit_main('/etc/passwd', stdin=io.BytesIO(b'{}'), env=env), 0)
        self.assertEqual(self.spool_events(), [])
        self.assertIn('pause hit failed', self.paths.hook_errors.read_text(encoding='utf-8'))

    def test_purge_stale_flags(self):
        proc = self.fake_proc(100, 'tmux: server', 555)
        now = NOW.timestamp()
        live = write_flag(self.paths, '100-1')
        dead = write_flag(self.paths, '200-1')
        old = write_flag(self.paths, '100-2')
        os.utime(old, (now - 8 * 86400, now - 8 * 86400))
        for path in (live, dead):
            os.utime(path, (now - 60, now - 60))
        (self.paths.pause / '.lock').touch()
        pause.purge_stale_flags(self.paths, now, str(proc))
        self.assertEqual(sorted(p.name for p in self.paths.pause.iterdir()), ['.lock', '100-1'])

    def fake_proc(self, pid, comm, start):
        proc = self.home / 'proc'
        (proc / str(pid)).mkdir(parents=True, exist_ok=True)
        fields = ['S', '1'] + ['0'] * 17 + [str(start)] + ['0'] * 5
        (proc / str(pid) / 'stat').write_text(f'{pid} ({comm}) ' + ' '.join(fields) + '\n', encoding='ascii')
        (proc / str(pid) / 'comm').write_text(comm + '\n', encoding='ascii')
        return proc

    def test_a_flag_of_a_reused_server_pid_is_dropped(self):
        proc = self.fake_proc(100, 'tmux: server', 555)
        self.fake_proc(200, 'bash', 555)
        now = NOW.timestamp()
        flags = {}
        for name, start in (('100-1', 555), ('100-2', 444), ('200-1', 555), ('300-1', 555), ('100-3', None)):
            flags[name] = write_flag(self.paths, name)
            if start is not None:
                common.atomic_write_json(flags[name], {**common.read_json_or_none(flags[name]), 'server_start': start})
            os.utime(flags[name], (now - 60, now - 60))
        pause.purge_stale_flags(self.paths, now, str(proc))
        self.assertEqual(sorted(p.name for p in self.paths.pause.iterdir()), ['100-1', '100-3'])

    def test_session_start_drops_stale_flags_before_any_tool_call(self):
        proc = self.fake_proc(100, 'tmux: server', 555)
        stale = write_flag(self.paths, '100-1')
        common.atomic_write_json(stale, {**common.read_json_or_none(stale), 'server_start': 444})
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(lambda *a, **k: RunResult(1, b'', b'')), environ={},
                           now=lambda: NOW, proc_root=str(proc))
        payload = {'hook_event_name': 'SessionStart', 'session_id': 's-1', 'source': 'startup'}
        self.assertEqual(hook.main(stdin=io.BytesIO(json.dumps(payload).encode()), stdout=io.BytesIO(), env=env), 0)
        self.assertFalse(stale.exists())

    def test_hourly_cleanup_purges_flags(self):
        write_flag(self.paths, '999999999-1')
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(), environ={}, now=lambda: NOW)
        hook.run_cleanup(env, common.load_config(self.paths))
        self.assertEqual(list(self.paths.pause.iterdir()), [])

    def test_paused_targets_without_tmux(self):
        write_flag(self.paths, '1-1', target='cc-a:0.0')
        write_flag(self.paths, '1-2', target='bad target')
        (self.paths.pause / 'junk').write_text('x', encoding='utf-8')
        self.assertEqual(pause.paused_targets(self.paths), {'cc-a:0.0'})


class PauseTmuxTest(TmuxTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='cedar')
        self.ctx = fast_ctx(self.home, projects_root=str(self.projects))

    def pane_ids(self, target):
        return tmux('display-message', '-p', '-t', f'={target}', '#{pid}\t#{pane_id}').stdout.strip().split('\t')

    def flags(self):
        return sorted(p.name for p in self.paths.pause.iterdir() if not p.name.startswith('.'))

    def run_tool(self, cwd, target):
        before = len([e for e in fake_log(cwd) if e['type'] == 'pause_hook'])
        tmux('send-keys', '-t', f'={target}', '-l', '/tool')
        tmux('send-keys', '-t', f'={target}', 'Enter')
        wait_until(lambda: len([e for e in fake_log(cwd) if e['type'] == 'pause_hook']) > before, timeout=15)
        return [e for e in fake_log(cwd) if e['type'] == 'pause_hook'][-1]

    def test_pause_writes_one_flag_named_after_server_and_pane(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        self.assertEqual(run_ctl(self.ctx, 'pause', '--target', target), (0, {'ok': True, 'paused': True}))
        server_pid, pane_id = self.pane_ids(target)
        self.assertEqual(self.flags(), [f'{server_pid}-{pane_id[1:]}'])
        flag = self.paths.pause / self.flags()[0]
        before = (flag.read_bytes(), flag.stat().st_mtime_ns)
        self.assertEqual(run_ctl(self.ctx, 'pause', '--target', target)[0], 0)
        self.assertEqual((flag.read_bytes(), flag.stat().st_mtime_ns), before)
        entry = common.read_json_or_none(flag)
        self.assertEqual((entry['target'], entry['hit']), (target, False))
        self.assertEqual(entry['server_start'], common.proc_start_ticks(int(server_pid)))
        self.assertEqual(flag.stat().st_mode & 0o777, 0o600)
        pause.purge_stale_flags(self.paths, time.time(), '/proc')
        self.assertTrue(flag.exists(), 'a flag of the live tmux server must survive the purge')

    def test_sessions_report_paused(self):
        app = self.start_claude_pane('cc-app', self.project('app'))
        other = self.start_claude_pane('cc-other', self.project('other'))
        run_ctl(self.ctx, 'pause', '--target', app)
        rows = {row['target']: row for row in run_ctl(self.ctx, 'sessions')[1]['sessions']}
        self.assertEqual((rows[app]['paused'], rows[other]['paused']), (True, False))
        write_flag(self.paths, '1-999', target=other)  # stale: another tmux server, never this pane
        rows = {row['target']: row for row in run_ctl(self.ctx, 'sessions')[1]['sessions']}
        self.assertFalse(rows[other]['paused'])

    def test_a_target_that_does_not_exist_is_not_found(self):
        cwd = self.project('app')
        self.start_claude_pane('cc-app', cwd)
        for wrong in ('cc-app:0.9', 'cc-app:3.0', 'cc-ap:0.0'):
            with self.subTest(target=wrong):
                code, out = run_ctl(self.ctx, 'pause', '--target', wrong)
                self.assertEqual((code, out['error']['code']), (4, 'not_found'))
                code, out = run_ctl(self.ctx, 'send', '--target', wrong, stdin=b'hello')
                self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        self.assertEqual(self.flags(), [])
        self.assertEqual(submits(cwd), [])

    def test_events_follow_the_pane_after_panes_were_renumbered(self):
        cwd = self.project('app')
        tmux('new-session', '-d', '-s', 'cc-app', '-c', str(cwd), '--', 'sleep', '300')
        tmux('split-window', '-t', '=cc-app:0', '-c', str(cwd), '--', str(self.claude))
        wait_for_event(cwd, lambda e: e['type'] == 'ready')
        server_pid, pane_id = self.pane_ids('cc-app:0.1')
        common.write_registry(self.paths, {'session_id': 'sess-r', 'tmux': 'cc-app:0.1', 'started_at': 'x',
                                           'pane_id': pane_id, 'server_pid': server_pid})
        tmux('kill-pane', '-t', '=cc-app:0.0')  # the Claude pane is now cc-app:0.0
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(), environ={'TMUX_PANE': pane_id,
                                                                   'TMUX': f'/tmp/x,{server_pid},0'})
        payload = {'hook_event_name': 'PreToolUse', 'session_id': 'sess-r', 'tool_name': 'Bash',
                   'tool_input': {'command': 'ls'}, 'tool_use_id': 't1'}
        from luady_kit import steps
        steps.main(stdin=io.BytesIO(json.dumps(payload).encode()), env=env)
        self.assertEqual(self.spool_events()[-1]['tmux'], 'cc-app:0.0')
        self.assertEqual(common.read_registry(self.paths, 'sess-r')['tmux'], 'cc-app:0.0')
        run_ctl(self.ctx, 'pause', '--target', 'cc-app:0.0')
        rows = {row['target']: row for row in run_ctl(self.ctx, 'sessions')[1]['sessions']}
        self.assertTrue(rows['cc-app:0.0']['paused'])

    def test_pause_refuses_missing_and_shell_panes(self):
        code, out = run_ctl(self.ctx, 'pause', '--target', 'cc-none:0.0')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        tmux('new-session', '-d', '-s', 'cc-shell', '--', 'sleep', '300')
        code, out = run_ctl(self.ctx, 'pause', '--target', 'cc-shell:0.0')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))
        self.assertEqual(self.flags(), [])

    def test_the_check_inside_the_pane_stops_only_a_flagged_pane(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        clean = self.run_tool(cwd, target)
        self.assertEqual((clean['code'], clean['stdout']), (0, ''))
        server_pid, _ = self.pane_ids(target)
        write_flag(self.paths, f'{server_pid}-999', target='cc-gone:0.0')
        other = self.run_tool(cwd, target)
        self.assertEqual((other['code'], other['stdout']), (0, ''))
        self.assertEqual(self.spool_events(), [])
        run_ctl(self.ctx, 'pause', '--target', target)
        hit = self.run_tool(cwd, target)
        self.assertEqual((hit['code'], hit['stdout']), (0, pause.STOP_OUTPUT))
        own = self.paths.pause / f'{server_pid}-{self.pane_ids(target)[1][1:]}'
        wait_until(lambda: (common.read_json_or_none(own) or {}).get('hit') is True)
        events = [e for e in self.spool_events() if e['event'] == 'paused']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['tmux'], target)

    def hook_env_for(self, target):
        server_pid, pane_id = self.pane_ids(target)
        env = hook.HookEnv(paths=self.paths, tmux=Tmux(), environ={'TMUX_PANE': pane_id, 'TMUX': f'/tmp/x,{server_pid},0'})
        return env, self.paths.pause / pause.flag_name(server_pid, pane_id)

    def test_a_hit_after_the_flag_was_lifted_types_the_resume_text(self):
        """resume ran between the shell's stop line and the hit: it saw no hit and typed nothing; the hit must."""
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        env, flag = self.hook_env_for(target)
        payload = json.dumps({'hook_event_name': 'PostToolUse', 'session_id': 's'}).encode()
        self.assertEqual(pause.hit_main(str(flag), stdin=io.BytesIO(payload), env=env, resume_delay=0.2), 0)
        wait_for_event(cwd, lambda e: e['type'] == 'submit' and e['text'] == pause.RESUME_TEXT, timeout=15)
        self.assertEqual([e['event'] for e in self.spool_events()], ['paused'])
        self.assertFalse(flag.exists())

    def test_a_normal_hit_or_a_new_pause_types_nothing(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        env, flag = self.hook_env_for(target)
        run_ctl(self.ctx, 'pause', '--target', target)
        payload = json.dumps({'hook_event_name': 'PostToolUse', 'session_id': 's'}).encode()
        pause.hit_main(str(flag), stdin=io.BytesIO(payload), env=env, resume_delay=0.2)
        self.assertTrue(common.read_json_or_none(flag)['hit'])
        run_ctl(self.ctx, 'resume', '--target', target)
        wait_for_event(cwd, lambda e: e['type'] == 'submit' and e['text'] == pause.RESUME_TEXT)
        pause.hit_main(str(flag), stdin=io.BytesIO(payload), env=env, resume_delay=1.0)  # lifted: resume later…
        run_ctl(self.ctx, 'pause', '--target', target)  # …but the owner paused again meanwhile
        time.sleep(2.0)
        self.assertEqual(submits(cwd).count(pause.RESUME_TEXT), 1)

    def test_resume_after_a_hit_types_the_resume_text(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        run_ctl(self.ctx, 'pause', '--target', target)
        self.run_tool(cwd, target)
        code, out = run_ctl(self.ctx, 'resume', '--target', target)
        self.assertEqual((code, out), (0, {'ok': True, 'was_hit': True, 'sent': True}))
        self.assertEqual(self.flags(), [])
        wait_for_event(cwd, lambda e: e['type'] == 'submit' and e['text'] == pause.RESUME_TEXT)

    def test_resume_without_a_hit_or_without_a_flag_types_nothing(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        run_ctl(self.ctx, 'pause', '--target', target)
        self.assertEqual(run_ctl(self.ctx, 'resume', '--target', target)[1], {'ok': True, 'was_hit': False, 'sent': False})
        self.assertEqual(self.flags(), [])
        self.assertEqual(run_ctl(self.ctx, 'resume', '--target', target)[1], {'ok': True, 'was_hit': False, 'sent': False})
        time.sleep(0.5)
        self.assertEqual(submits(cwd), [])

    def test_resume_with_a_pending_question_removes_the_flag_but_types_nothing(self):
        cwd = self.project('app')
        target = self.start_claude_pane('cc-app', cwd)
        run_ctl(self.ctx, 'pause', '--target', target)
        self.run_tool(cwd, target)
        own = os.getpid()
        common.atomic_write_json(common.pending_path(self.paths, 'QQQQQQQQ'), {
            'qid': 'QQQQQQQQ', 'kind': 'question', 'created_at': '2026-11-14T09:00:00.000Z', 'session_id': 's',
            'tmux': target, 'payload': {}, 'meta': {}, 'pid': own, 'pid_start': common.proc_start_ticks(own)})
        self.assertEqual(run_ctl(self.ctx, 'resume', '--target', target)[1], {'ok': True, 'was_hit': True, 'sent': False})
        self.assertEqual(self.flags(), [])
        self.assertNotIn(pause.RESUME_TEXT, submits(cwd))

    def test_resume_of_a_gone_pane_clears_its_flags(self):
        write_flag(self.paths, '1-5', target='cc-gone:0.0', hit=True)
        write_flag(self.paths, '1-6', target='cc-kept:0.0')
        self.assertEqual(run_ctl(self.ctx, 'resume', '--target', 'cc-gone:0.0')[1],
                         {'ok': True, 'was_hit': True, 'sent': False})
        self.assertEqual(self.flags(), ['1-6'])


if __name__ == '__main__':
    unittest.main()
