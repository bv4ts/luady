"""luady-ctl parsing, validation, dispatch, exit codes and the config verb."""
from __future__ import annotations

import dataclasses
import io
import json
import unittest
from pathlib import Path
from unittest import mock

from luady_kit import common, ctl
from luady_kit.common import CtlError
from tests.ctl_helpers import make_ctx, raw_ctl, run_ctl
from tests.helpers import HomeTestCase

C3_VERBS = {'version', 'sysinfo', 'sessions', 'pending', 'tail-events', 'answer', 'permission', 'send', 'keys',
            'start', 'stop', 'restart', 'delete', 'transcript', 'capture', 'update-claude', 'projects', 'exec',
            'file-read', 'file-get', 'file-put', 'file-write', 'config',
            'graphify-run', 'graph-query', 'auth-status', 'auth-login', 'auth-code', 'pause', 'resume', 'auth-logout',
            'skills', 'kb-put', 'git-status'}


def _echo(ns, ctx, kit_io):
    return {'verb': ns.verb, 'args': {k: v for k, v in vars(ns).items() if k != 'verb'}}


class ExplodingStdin(io.RawIOBase):
    def read(self, size=-1):
        raise AssertionError('stdin must not be read by this verb')


class CtlCoreTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = make_ctx(self.home)
        self.echo = {verb: _echo for verb in C3_VERBS}

    def assertUsage(self, *argv):
        code, out = run_ctl(self.ctx, *argv, handlers=self.echo)
        self.assertEqual(code, 2, out)
        self.assertEqual(out['error']['code'], 'usage')

    def test_dispatch_table_covers_exactly_the_c3_verbs(self):
        self.assertEqual(set(ctl.VERBS), C3_VERBS)
        self.assertEqual(set(ctl.SPECS) | {'config'}, C3_VERBS)

    def test_valid_arguments_reach_the_handler(self):
        code, out = run_ctl(self.ctx, 'start', '--name', 'app.v2', '--cwd', '/home/dev/projects/x/../app/',
                            '--model', 'opus[1m]', '--resume', 'abc-123', handlers=self.echo)
        self.assertEqual(code, 0)
        self.assertEqual(out['args'], {'name': 'app.v2', 'cwd': '/home/dev/projects/app', 'model': 'opus[1m]',
                                       'resume': 'abc-123'})

    def test_unknown_verb_and_missing_flags_are_usage(self):
        self.assertUsage('nope')
        self.assertUsage()
        self.assertUsage('send')
        self.assertUsage('keys', '--target', 'cc-a:0.0', '--key', 'C-d')
        self.assertUsage('-h')
        self.assertUsage('send', '--targ', 'cc-a:0.0')

    def test_argument_patterns_are_enforced(self):
        self.assertUsage('send', '--target', 'cc-a;rm -rf /:0.0')
        self.assertUsage('send', '--target', 'cc-a:0.0\n')
        self.assertUsage('answer', '--qid', 'abcdefgh')
        self.assertUsage('start', '--name', 'a b', '--cwd', '/x')
        self.assertUsage('delete', '--session', '../etc')
        self.assertUsage('file-read', '--path', 'etc/passwd', '--max', '10')
        self.assertUsage('file-write', '--path', '/tmp/a\nb')
        self.assertUsage('capture', '--target', 'cc-a:0.0', '--lines', '501')
        self.assertUsage('capture', '--target', 'cc-a:0.0', '--lines', '٥')
        self.assertUsage('exec', '--cwd', '/tmp', '--timeout', '601')
        self.assertUsage('tail-events', '--from', 'events-2026.jsonl:5')

    def test_transcript_window_rules(self):
        self.assertUsage('transcript', '--session', 'abc')
        self.assertUsage('transcript', '--session', 'abc', '--tail', '10', '--max', '5')
        self.assertUsage('transcript', '--session', 'abc', '--from', '0')
        self.assertUsage('transcript', '--session', 'abc', '--from', '0', '--before', '9', '--max', '5')
        code, out = run_ctl(self.ctx, 'transcript', '--session', 'abc', '--before', '9', '--max', '5',
                            handlers=self.echo)
        self.assertEqual((code, out['args']['before'], out['args']['max']), (0, 9, 5))

    def test_error_codes_map_to_exit_codes(self):
        for name, exit_code in common.EXIT_CODES.items():
            if name == 'ok':
                continue

            def boom(ns, ctx, kit_io, name=name):
                raise CtlError(name, f'{name} happened')

            code, out = run_ctl(self.ctx, 'version', handlers={'version': boom})
            self.assertEqual((code, out), (exit_code, {'error': {'code': name, 'message': f'{name} happened'}}))

    def test_unexpected_exception_is_failed_json(self):
        def boom(ns, ctx, kit_io):
            raise ValueError('bad state')

        code, out = run_ctl(self.ctx, 'version', handlers={'version': boom})
        self.assertEqual((code, out), (1, {'error': {'code': 'failed', 'message': 'ValueError: bad state'}}))

    def test_output_is_exactly_one_json_line(self):
        code, raw = raw_ctl(self.ctx, 'config', '--get')
        self.assertEqual(code, 0)
        self.assertEqual(raw.count('\n'), 1)
        self.assertEqual(set(json.loads(raw)), {'remote_answering', 'hook_wait_seconds', 'host_alias'})

    def test_verbs_without_input_never_read_stdin(self):
        code = ctl.main(['config', '--get'], stdin=ExplodingStdin(), stdout=io.BytesIO(), ctx=self.ctx)
        self.assertEqual(code, 0)

    def test_config_get_and_set(self):
        self.write_config(host_alias='cedar')
        self.assertEqual(run_ctl(self.ctx, 'config', '--get'),
                         (0, {'remote_answering': True, 'hook_wait_seconds': 14400, 'host_alias': 'cedar'}))
        self.assertFalse(run_ctl(self.ctx, 'config', '--set', 'remote_answering=false')[1]['remote_answering'])
        self.assertEqual(run_ctl(self.ctx, 'config', '--set', 'hook_wait_seconds=600')[1]['hook_wait_seconds'], 600)
        self.assertEqual(common.load_config(self.paths),
                         {'remote_answering': False, 'hook_wait_seconds': 600, 'host_alias': 'cedar',
                          'projects_root': str(self.paths.home / 'projects'), 'claude_bin': None})

    def test_config_set_keeps_the_stored_paths_and_get_keeps_the_c3_shape(self):
        self.write_config(host_alias='cedar', projects_root='/srv/projects', claude_bin='/opt/claude/bin/claude')
        self.assertEqual(set(run_ctl(self.ctx, 'config', '--get')[1]), set(ctl.CONFIG_KEYS))
        code, out = run_ctl(self.ctx, 'config', '--set', 'remote_answering=false')
        self.assertEqual((code, set(out)), (0, set(ctl.CONFIG_KEYS)))
        self.assertEqual(common.read_json_or_none(self.paths.config_file),
                         {'remote_answering': False, 'hook_wait_seconds': 14400, 'host_alias': 'cedar',
                          'projects_root': '/srv/projects', 'claude_bin': '/opt/claude/bin/claude'})

    def test_config_set_writes_no_path_defaults(self):
        self.write_config(host_alias='cedar')
        run_ctl(self.ctx, 'config', '--set', 'hook_wait_seconds=600')
        self.assertEqual(common.read_json_or_none(self.paths.config_file),
                         {'remote_answering': True, 'hook_wait_seconds': 600, 'host_alias': 'cedar'})

    def test_config_rejects_bad_keys_and_values(self):
        for setting in ('host_alias=x', 'remote_answering=yes', 'hook_wait_seconds=59',
                        'hook_wait_seconds=86401', 'novalue'):
            code, out = run_ctl(self.ctx, 'config', '--set', setting)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), setting)
        self.assertUsage('config')
        self.assertUsage('config', '--get', '--set', 'remote_answering=true')

    def test_missing_verb_module_is_failed(self):
        with mock.patch.dict(ctl.VERBS, {'version': ('no_such_module', 'cmd_version')}):
            code, out = run_ctl(self.ctx, 'version')
        self.assertEqual((code, out['error']['code']), (1, 'failed'))

    def test_kit_io_limits_and_decoding(self):
        with self.assertRaises(CtlError):
            ctl.KitIO(io.BytesIO(b'x' * 11), io.BytesIO()).read_bytes(10)
        with self.assertRaises(CtlError):
            ctl.KitIO(io.BytesIO(b'\xff\xfe'), io.BytesIO()).read_text(10)
        with self.assertRaises(CtlError):
            ctl.KitIO(io.BytesIO(b'{bad'), io.BytesIO()).read_json(10)
        payload = '{"a": "م"}'.encode('utf-8')
        self.assertEqual(ctl.KitIO(io.BytesIO(payload), io.BytesIO()).read_json(100), {'a': 'م'})

    def test_a_ctx_without_a_projects_root_uses_projects_in_its_home(self):
        self.assertEqual(ctl.Ctx(paths=common.KitPaths(self.home)).projects_root, str(self.home / 'projects'))
        self.assertEqual(ctl.Ctx(paths=common.KitPaths(self.home), projects_root='/srv/work').projects_root, '/srv/work')

    def test_build_ctx_uses_home(self):
        self.assertEqual(ctl.build_ctx({'HOME': str(self.home)}).paths.root, self.home / '.luady')

    def test_build_ctx_without_stored_paths_uses_the_home_defaults(self):
        for write in (False, True):
            with self.subTest(config_file=write):
                if write:
                    self.write_config(host_alias='cedar')
                built = ctl.build_ctx({'HOME': str(self.home)})
                # ~/projects of the user the kit runs as, never a fixed folder.
                self.assertEqual(built.projects_root, str(self.home / 'projects'))
                self.assertEqual(built.paths.claude_bin, self.home / '.local' / 'bin' / 'claude')
                self.assertEqual(built.paths, common.KitPaths(self.home))

    def test_build_ctx_uses_the_stored_projects_root_and_claude_bin(self):
        self.write_config(host_alias='cedar', projects_root='/srv/projects', claude_bin='/opt/claude/bin/claude')
        built = ctl.build_ctx({'HOME': str(self.home)})
        self.assertEqual(built.projects_root, '/srv/projects')
        self.assertEqual(built.paths.claude_bin, Path('/opt/claude/bin/claude'))
        self.assertEqual((built.paths.home, built.paths.config_file), (self.home, self.paths.config_file))

    def test_a_built_ctx_takes_the_stored_paths_to_the_verbs(self):
        projects = self.home / 'work'
        (projects / 'app' / '.git').mkdir(parents=True)
        self.assertTrue(common.matches(common.PATH_SETTING_RE, str(projects)), 'the temporary home must follow the rule')
        self.write_config(host_alias='cedar', projects_root=str(projects), claude_bin='/opt/claude/bin/claude')
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            return common.RunResult(0, b'2.1.325 (Claude Code)\n', b'')

        built = dataclasses.replace(ctl.build_ctx({'HOME': str(self.home)}), run=fake_run)
        self.assertEqual(run_ctl(built, 'version')[1]['claude'], '2.1.325')
        self.assertIn(['/opt/claude/bin/claude', '--version'], calls)
        self.assertEqual([row['name'] for row in run_ctl(built, 'projects')[1]['projects']], ['app'])


if __name__ == '__main__':
    unittest.main()
