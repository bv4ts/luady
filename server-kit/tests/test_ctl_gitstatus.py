"""The git-status verb (kit 2.1): branch, changes, ahead/behind and last commit of every project, offline."""
from __future__ import annotations

import json
import subprocess
import unittest

from luady_kit import gitstatus
from luady_kit.common import RunResult
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase

NULLS = {'branch': None, 'dirty': None, 'ahead': None, 'behind': None, 'lastCommitAt': None}


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


def commit(repo, name, text='x'):
    (repo / name).write_text(text, encoding='utf-8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', f'add {name}')


class ParseTest(unittest.TestCase):
    def test_parse_porcelain_v2(self):
        text = ('# branch.oid abc\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +2 -3\n'
                '1 .M N... 100644 100644 100644 a b f.txt\n? new.txt\n')
        self.assertEqual(gitstatus.parse_status(text), {'branch': 'feature/x', 'dirty': 2, 'ahead': 2, 'behind': 3})

    def test_detached_and_no_upstream(self):
        self.assertEqual(gitstatus.parse_status('# branch.oid abc\n# branch.head (detached)\n'),
                         {'branch': None, 'dirty': 0, 'ahead': None, 'behind': None})

    def test_odd_ab_line(self):
        self.assertEqual(gitstatus.parse_status('# branch.head main\n# branch.ab +x -1\n')['ahead'], None)


class CtlGitStatusTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.root = self.home / 'projects'
        self.ctx = make_ctx(self.home)

    def make_repo(self, relative):
        repo = self.root / relative
        repo.mkdir(parents=True)
        git(repo, 'init', '-q')
        return repo

    def rows(self, ctx=None):
        code, out = run_ctl(ctx or self.ctx, 'git-status')
        self.assertEqual(code, 0, out)
        return {row['name']: row for row in out['projects']}

    def test_clean_dirty_ahead_behind_and_fresh_repos(self):
        upstream = self.home / 'upstream.git'
        subprocess.run(['git', 'init', '-q', '--bare', str(upstream)], check=True)
        app = self.make_repo('app')
        commit(app, 'a.txt')
        git(app, 'remote', 'add', 'origin', str(upstream))
        git(app, 'push', '-q', '-u', 'origin', 'main')
        commit(app, 'b.txt')
        commit(app, 'c.txt')
        (app / 'a.txt').write_text('changed', encoding='utf-8')
        (app / 'untracked.txt').write_text('u', encoding='utf-8')
        clean = self.make_repo('clients/harbor')
        commit(clean, 'readme.md')
        self.make_repo('fresh')
        rows = self.rows()
        self.assertEqual(sorted(rows), ['app', 'fresh', 'harbor'])
        first = rows['app']
        self.assertEqual((first['path'], first['branch'], first['dirty'], first['ahead'], first['behind']),
                         (str(app), 'main', 2, 2, 0))
        self.assertRegex(first['lastCommitAt'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}')
        self.assertEqual({k: rows['harbor'][k] for k in ('branch', 'dirty', 'ahead', 'behind')},
                         {'branch': 'main', 'dirty': 0, 'ahead': None, 'behind': None})
        self.assertEqual((rows['fresh']['branch'], rows['fresh']['dirty'], rows['fresh']['lastCommitAt']),
                         ('main', 0, None))
        self.assertEqual(set(first), {'path', 'name', 'branch', 'dirty', 'ahead', 'behind', 'lastCommitAt'})

    def test_behind_after_the_upstream_moves(self):
        upstream = self.home / 'up.git'
        subprocess.run(['git', 'init', '-q', '--bare', str(upstream)], check=True)
        app = self.make_repo('app')
        commit(app, 'a.txt')
        git(app, 'remote', 'add', 'origin', str(upstream))
        git(app, 'push', '-q', '-u', 'origin', 'main')
        other = self.home / 'other'
        subprocess.run(['git', 'clone', '-q', str(upstream), str(other)], check=True)
        commit(other, 'z.txt')
        git(other, 'push', '-q')
        git(app, 'fetch', '-q')
        row = self.rows()['app']
        self.assertEqual((row['ahead'], row['behind']), (0, 1))

    def test_never_prints_remote_urls_or_fetches(self):
        app = self.make_repo('app')
        commit(app, 'a.txt')
        git(app, 'remote', 'add', 'origin', 'https://' + 'user:s3cret' + '@example.invalid/x.git')
        calls = []

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            calls.append(argv)
            from luady_kit import common
            return common.run_process(argv, input_bytes, timeout, cwd)

        code, out = run_ctl(make_ctx(self.home, run=run), 'git-status')
        self.assertEqual(code, 0)
        self.assertNotIn('s3cret', json.dumps(out))
        self.assertNotIn('example.invalid', json.dumps(out))
        self.assertFalse(any(word in argv for argv in calls for word in ('fetch', 'pull', 'remote', 'ls-remote')))

    def test_a_repo_config_never_starts_a_program(self):
        app = self.make_repo('app')
        commit(app, 'a.txt')
        calls = []

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            calls.append(argv)
            from luady_kit import common
            return common.run_process(argv, input_bytes, timeout, cwd)

        self.assertEqual(run_ctl(make_ctx(self.home, run=run), 'git-status')[0], 0)
        self.assertEqual(len(calls), 2)
        for argv in calls:
            self.assertEqual(argv[:3], ['git', '-c', 'log.showSignature=false'])
            self.assertIn('core.fsmonitor=false', argv)

    def test_a_failing_or_slow_repo_is_listed_with_nulls(self):
        self.make_repo('bad')
        self.make_repo('good')
        seen = []

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            seen.append(timeout)
            if '/bad' in ' '.join(argv):
                return RunResult(124, b'', b'', timed_out=True)
            if 'status' in argv:
                return RunResult(0, b'# branch.head main\n', b'')
            return RunResult(0, b'2026-11-15T10:00:00+04:00\n', b'')

        rows = self.rows(make_ctx(self.home, run=run))
        self.assertEqual({k: rows['bad'][k] for k in NULLS}, NULLS)
        self.assertEqual(rows['good']['lastCommitAt'], '2026-11-15T10:00:00+04:00')
        self.assertTrue(all(0 < t <= gitstatus.REPO_TIMEOUT_SECONDS for t in seen))

    def test_overall_deadline_lists_the_rest_with_nulls(self):
        for name in ('a', 'b', 'c'):
            self.make_repo(name)
        clock = [0.0]

        def monotonic():
            return clock[0]

        def run(argv, input_bytes=None, timeout=10.0, cwd=None):
            clock[0] += 20.0  # every call eats 20 of the 25 seconds
            return RunResult(0, b'# branch.head main\n' if 'status' in argv else b'', b'')

        ctx = make_ctx(self.home, run=run, monotonic=monotonic)
        code, out = run_ctl(ctx, 'git-status')
        self.assertEqual(code, 0)
        rows = out['projects']
        self.assertEqual([(r['name'], r['branch']) for r in rows], [('a', 'main'), ('b', 'main'), ('c', None)])
        self.assertEqual({k: rows[2][k] for k in NULLS}, NULLS)

    def test_without_root_is_empty(self):
        self.assertEqual(run_ctl(make_ctx(self.home, projects_root='/nonexistent-root'), 'git-status'),
                         (0, {'projects': []}))


if __name__ == '__main__':
    unittest.main()
