"""version, sysinfo, update-claude and projects verbs."""
from __future__ import annotations

import platform
import subprocess
import unittest

from luady_kit import __version__, common, projects
from luady_kit.common import RunResult
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase
from tests.tmux_helpers import install_fake_claude


def git(repo, *args):
    subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)


class CtlSysinfoTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        install_fake_claude(self.home)
        self.ctx = make_ctx(self.home)

    def test_version_reports_kit_claude_tmux_python(self):
        code, out = run_ctl(self.ctx, 'version')
        self.assertEqual(code, 0)
        self.assertEqual((out['kit'], out['claude'], out['python']), (__version__, '2.1.295', platform.python_version()))
        self.assertRegex(out['tmux'], r'^[0-9]+\.[0-9]+')

    def test_version_without_claude_is_null(self):
        self.paths.claude_bin.unlink()
        self.assertIsNone(run_ctl(self.ctx, 'version')[1]['claude'])

    def test_sysinfo_from_proc(self):
        proc = self.home / 'fakeproc'
        proc.mkdir()
        (proc / 'loadavg').write_text('0.52 0.40 0.30 1/234 5678\n', encoding='ascii')
        (proc / 'meminfo').write_text('MemTotal:        8000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n',
                                      encoding='ascii')
        (proc / 'uptime').write_text('12345.67 40000.00\n', encoding='ascii')
        code, out = run_ctl(make_ctx(self.home, proc_root=str(proc)), 'sysinfo')
        self.assertEqual(code, 0)
        self.assertEqual({key: out[key] for key in ('load1', 'load5', 'mem_total_kb', 'mem_avail_kb', 'uptime_s')},
                         {'load1': 0.52, 'load5': 0.40, 'mem_total_kb': 8000000, 'mem_avail_kb': 4000000,
                          'uptime_s': 12345})
        self.assertIsInstance(out['disk_free_kb'], int)
        self.assertIsInstance(out['disk_total_kb'], int)
        self.assertGreaterEqual(out['disk_total_kb'], out['disk_free_kb'])
        code, real = run_ctl(self.ctx, 'sysinfo')
        self.assertEqual((code, set(real)),
                         (0, {'load1', 'load5', 'mem_total_kb', 'mem_avail_kb', 'disk_free_kb', 'disk_total_kb', 'uptime_s'}))

    def test_update_claude_reports_versions(self):
        code, out = run_ctl(self.ctx, 'update-claude')
        self.assertEqual((code, out['before'], out['after']), (0, '2.1.295', '2.1.296'))
        self.assertIn('Updated Claude Code', out['output'])

    def test_update_claude_timeout_and_missing(self):
        def slow(argv, input_bytes=None, timeout=10.0, cwd=None):
            if argv[-1] == 'update':
                return RunResult(124, b'', b'', timed_out=True)
            return common.run_process(argv, input_bytes, timeout, cwd)

        code, out = run_ctl(make_ctx(self.home, run=slow), 'update-claude')
        self.assertEqual((code, out['error']['code']), (5, 'timeout'))
        self.paths.claude_bin.unlink()
        code, out = run_ctl(self.ctx, 'update-claude')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))


class CtlProjectsTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.root = self.home / 'projects'
        self.ctx = make_ctx(self.home)

    def make_repo(self, relative, files=(), commits=0, remote=None):
        repo = self.root / relative
        repo.mkdir(parents=True)
        git(repo, 'init', '-q')
        for name in files:
            (repo / name).write_text('x', encoding='utf-8')
        for index in range(commits):
            (repo / f'f{index}.txt').write_text(str(index), encoding='utf-8')
            git(repo, 'add', '-A')
            git(repo, 'commit', '-q', '-m', f'commit {index}')
        if remote:
            git(repo, 'remote', 'add', 'origin', remote)
        return repo

    def test_projects_lists_repos_with_git_info_and_stack(self):
        app = self.make_repo('meadow-hr', files=('package.json', 'next.config.mjs', 'Dockerfile'), commits=6,
                             remote='git@github.com:example-org/meadow-hr.git')
        nested = self.make_repo('clients/harbor', files=('composer.json', 'artisan', 'requirements.txt', 'pyproject.toml'))
        self.make_repo('meadow-hr/packages/inner')
        (self.root / 'notes').mkdir()
        (self.root / '.cache').mkdir()
        code, out = run_ctl(self.ctx, 'projects')
        self.assertEqual(code, 0)
        by_name = {project['name']: project for project in out['projects']}
        self.assertEqual(sorted(by_name), ['harbor', 'meadow-hr'])
        first = by_name['meadow-hr']
        self.assertEqual((first['path'], first['remote'], first['branch']),
                         (str(app), 'git@github.com:example-org/meadow-hr.git', 'main'))
        self.assertEqual([c['subject'] for c in first['commits']], [f'commit {i}' for i in (5, 4, 3, 2, 1)])
        self.assertRegex(first['commits'][0]['hash'], r'^[0-9a-f]{40}$')
        self.assertRegex(first['commits'][0]['date'], r'^\d{4}-\d{2}-\d{2}T')
        self.assertEqual(first['stack'], ['node', 'next', 'docker'])
        second = by_name['harbor']
        self.assertEqual((second['path'], second['remote'], second['branch'], second['commits'], second['stack']),
                         (str(nested), None, None, [], ['php', 'laravel', 'python']))

    def test_projects_never_return_the_credentials_of_a_remote(self):
        self.make_repo('signed-in', remote='https://' + 'bob:hunter2' + '@git.example.com/team/app.git')
        _, out = run_ctl(self.ctx, 'projects')
        [project] = out['projects']
        self.assertEqual(project['remote'], 'https://git.example.com/team/app.git')

    def test_projects_never_let_a_repo_config_run_a_signature_program(self):
        self.make_repo('app', commits=1)
        calls = []

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            calls.append(argv)
            return common.run_process(argv, input_bytes, timeout, cwd)

        self.assertEqual(run_ctl(make_ctx(self.home, run=run), 'projects')[0], 0)
        self.assertTrue(calls)
        self.assertTrue(all(argv[:3] == ['git', '-c', 'log.showSignature=false'] for argv in calls), calls)

    def test_without_credentials(self):
        cases = [
            ('https://' + 'x-access-token:abc123' + '@git.example.com/r.git', 'https://git.example.com/r.git'),
            ('https://' + 'tok3nvalue' + '@git.example.com/r', 'https://git.example.com/r'),
            ('ssh://git:secret@git.example.com:22/r.git', 'ssh://git@git.example.com:22/r.git'),
            ('ssh://git@git.example.com/r.git', 'ssh://git@git.example.com/r.git'),
            ('git@git.example.com:team/r.git', 'git@git.example.com:team/r.git'),
            ('https://git.example.com/a@b/r.git', 'https://git.example.com/a@b/r.git'),
            ('/srv/git/r.git', '/srv/git/r.git'),
            ('git+https://' + 'tok3nvalue' + '@git.example.com/o/r.git', 'git+https://git.example.com/o/r.git'),
            ('HTTPS://' + 'bob:hunter2' + '@git.example.com/r', 'HTTPS://git.example.com/r'),
            ('https://git.example.com/o/r.git?private_token=' + 'glp' + 'at-Ab12Cd34Ef56Gh78Ij90',
             'https://git.example.com/o/r.git?private_token=[redacted]'),
            ('bob:' + 'tok3nvalue' + '@git.example.com:o/r.git', 'bob@git.example.com:o/r.git'),
        ]
        for remote, expected in cases:
            with self.subTest(remote=remote):
                self.assertEqual(projects.without_credentials(remote), expected)
        self.assertIsNone(projects.without_credentials(None))

    def test_projects_without_root_is_empty(self):
        self.assertEqual(run_ctl(make_ctx(self.home, projects_root='/nonexistent-root'), 'projects'),
                         (0, {'projects': []}))


if __name__ == '__main__':
    unittest.main()
