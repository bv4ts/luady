"""install.py --projects-root / --claude-bin (kept in state/config.json) and the shims' Python version check."""
from __future__ import annotations

import ast
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

from luady_kit import common, install

KIT_ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)
SHIMS = (KIT_ROOT / 'install.py', KIT_ROOT / 'bin' / 'luady-ctl')
BASE_CONFIG = {'remote_answering': True, 'hook_wait_seconds': 14400, 'host_alias': 'cedar'}
HOSTILE = {
    'relative': 'srv/projects',
    'dot-dot': '/srv/projects/../etc',
    'semicolon': '/srv/projects;id',
    'space': '/srv/my projects',
    'newline': '/srv/projects\nx',
    'too long': '/' + 'a' * 256,
}
# Runs a shim as __main__ on a pretend Python 3.9, then reports its exit code and whether luady_kit was imported.
OLD_PYTHON_PROBE = (
    'import collections, runpy, sys\n'
    "Version = collections.namedtuple('Version', 'major minor micro releaselevel serial')\n"
    "sys.version_info = Version(3, 9, 18, 'final', 0)\n"
    'try:\n'
    "    runpy.run_path(sys.argv[1], run_name='__main__')\n"
    'except SystemExit as exc:\n'
    "    print(exc.code, 'luady_kit' in sys.modules)\n"
)


def load_shim(path: Path) -> dict:
    """A shim's functions, without its __main__ part (so nothing is imported from luady_kit)."""
    namespace = {'__name__': 'luady_shim_under_test', '__file__': str(path)}
    exec(compile(path.read_text(encoding='utf-8'), str(path), 'exec'), namespace)  # noqa: S102 - our own file
    return namespace


class InstallPathOptionsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='luadypaths-', ignore_cleanup_errors=True)
        self.home = Path(self._tmp.name)
        self.paths = common.KitPaths(self.home)
        (self.home / '.claude').mkdir()
        self.assertTrue(common.matches(common.PATH_SETTING_RE, str(self.home)), 'the temporary home must follow the rule')

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = install.main(['--host-alias', 'cedar', '--home', str(self.home), *argv], now=NOW, src=KIT_ROOT)
        return code, out.getvalue(), err.getvalue()

    def summary(self, *argv):
        code, out, err = self.run_main(*argv)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def stored(self):
        return common.read_json_or_none(self.paths.config_file)

    def fake_claude(self, version):
        path = self.home / 'opt' / 'claude' / 'bin' / 'claude'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'#!/bin/sh\necho "{version} (Claude Code)"\n', encoding='ascii')
        path.chmod(0o755)
        return path

    def test_both_flags_are_stored_and_reported(self):
        summary = self.summary('--projects-root', '/srv/projects', '--claude-bin', '/opt/claude/bin/claude')
        self.assertEqual((summary['projects_root'], summary['claude_bin']), ('/srv/projects', '/opt/claude/bin/claude'))
        self.assertEqual(self.stored(), {**BASE_CONFIG, 'projects_root': '/srv/projects',
                                         'claude_bin': '/opt/claude/bin/claude'})

    def test_without_flags_nothing_is_stored_and_the_summary_shows_the_defaults(self):
        summary = self.summary()
        self.assertEqual((summary['projects_root'], summary['claude_bin']), (str(self.home / 'projects'), None))
        self.assertEqual(self.stored(), BASE_CONFIG)

    def test_a_later_install_keeps_the_stored_values_and_new_flags_replace_them(self):
        self.summary('--projects-root', '/srv/projects', '--claude-bin', '/opt/claude/bin/claude')
        common.atomic_write_json(self.paths.config_file, {**self.stored(), 'hook_wait_seconds': 600})
        again = self.summary()
        self.assertEqual((again['projects_root'], again['claude_bin']), ('/srv/projects', '/opt/claude/bin/claude'))
        self.assertEqual(self.stored(), {**BASE_CONFIG, 'hook_wait_seconds': 600, 'projects_root': '/srv/projects',
                                         'claude_bin': '/opt/claude/bin/claude'})
        one = self.summary('--projects-root', '/home/dev/work')
        self.assertEqual((one['projects_root'], one['claude_bin']), ('/home/dev/work', '/opt/claude/bin/claude'))
        self.summary('--projects-root', '/srv/repos', '--claude-bin', '/usr/local/bin/claude')
        self.assertEqual((self.stored()['projects_root'], self.stored()['claude_bin']),
                         ('/srv/repos', '/usr/local/bin/claude'))

    def test_an_invalid_stored_value_is_not_carried_over(self):
        self.summary('--projects-root', '/srv/projects')
        common.atomic_write_json(self.paths.config_file, {**self.stored(), 'claude_bin': '/opt/my claude'})
        summary = self.summary()
        self.assertEqual((summary['projects_root'], summary['claude_bin']), ('/srv/projects', None))
        self.assertNotIn('claude_bin', self.stored())

    def test_hostile_values_are_refused_before_any_change(self):
        for flag in ('--projects-root', '--claude-bin'):
            for label, value in HOSTILE.items():
                with self.subTest(flag=flag, value=label):
                    code, out, err = self.run_main(flag, value)
                    self.assertEqual((code, out), (1, ''))
                    error = json.loads(err)
                    self.assertFalse(error['ok'])
                    self.assertEqual(error['error'], f'{flag} must be {install.PATH_RULE}')
                    self.assertNotIn(value, error['error'])
                    self.assertNotIn(value, err)
                    self.assertFalse(self.paths.lib.exists())
                    self.assertFalse(self.paths.config_file.exists())

    def test_the_version_probe_runs_the_given_claude_bin_then_the_stored_one(self):
        claude = self.fake_claude('2.1.325')
        self.assertFalse(self.paths.claude_bin.exists(), 'nothing may answer at ~/.local/bin/claude')
        summary = self.summary('--claude-bin', str(claude))
        self.assertEqual((summary['steps'], summary['claude_bin']), ('on', str(claude)))
        self.assertEqual(self.summary()['steps'], 'on')
        self.assertTrue(self.summary('--claude-bin', str(self.home / 'missing' / 'claude'))['steps'].startswith('off:'))

    def test_the_installed_luady_ctl_uses_the_stored_paths(self):
        claude = self.fake_claude('2.1.325')
        projects = self.home / 'work'
        (projects / 'app' / '.git').mkdir(parents=True)
        self.summary('--skip-settings', '--projects-root', str(projects), '--claude-bin', str(claude))
        env = {**os.environ, 'HOME': str(self.home)}

        def ctl(*argv):
            ran = subprocess.run([str(self.paths.bin / 'luady-ctl'), *argv], env=env, capture_output=True, text=True,
                                 timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)
            return json.loads(ran.stdout)

        self.assertEqual(ctl('version')['claude'], '2.1.325')
        self.assertEqual([row['name'] for row in ctl('projects')['projects']], ['app'])

    def test_uninstall_leaves_the_stored_paths(self):
        self.summary('--projects-root', '/srv/projects', '--claude-bin', '/opt/claude/bin/claude')
        self.assertEqual(self.run_main('--uninstall')[0], 0)
        self.assertEqual((self.stored()['projects_root'], self.stored()['claude_bin']),
                         ('/srv/projects', '/opt/claude/bin/claude'))

    def test_the_install_shim_passes_the_flags_through(self):
        def shim(*argv):
            return subprocess.run([sys.executable, str(KIT_ROOT / 'install.py'), '--host-alias', 'cedar', '--home',
                                   str(self.home), '--skip-settings', *argv], capture_output=True, text=True, timeout=60)

        ran = shim('--projects-root', '/srv/projects')
        self.assertEqual(ran.returncode, 0, ran.stderr)
        self.assertEqual(json.loads(ran.stdout)['projects_root'], '/srv/projects')
        refused = shim('--claude-bin', 'claude')
        self.assertEqual(refused.returncode, 1)
        self.assertEqual(json.loads(refused.stderr), {'ok': False, 'error': f'--claude-bin must be {install.PATH_RULE}'})


class PythonVersionCheckTest(unittest.TestCase):
    def test_the_shims_refuse_python_older_than_3_10(self):
        for path in SHIMS:
            for old, found in (((3, 9), '3.9'), ((3, 9, 18, 'final', 0), '3.9'), ((3, 6, 15), '3.6')):
                with self.subTest(shim=path.name, version=old):
                    stream = io.StringIO()
                    self.assertEqual(load_shim(path)['check_python'](old, stream), 1)
                    self.assertEqual(json.loads(stream.getvalue()),
                                     {'ok': False, 'error': f'Python 3.10 or later is needed (found {found})'})

    def test_the_shims_accept_python_3_10_and_later(self):
        for path in SHIMS:
            shim = load_shim(path)
            for new in ((3, 10), (3, 10, 0), (3, 12, 3), (4, 0), sys.version_info):
                with self.subTest(shim=path.name, version=tuple(new)):
                    stream = io.StringIO()
                    self.assertEqual(shim['check_python'](new, stream), 0)
                    self.assertEqual(stream.getvalue(), '')
            self.assertEqual(shim['check_python'](), 0)

    def test_an_old_python_is_refused_before_the_kit_is_imported(self):
        for path in SHIMS:
            with self.subTest(shim=path.name):
                ran = subprocess.run([sys.executable, '-I', '-c', OLD_PYTHON_PROBE, str(path)], capture_output=True,
                                     text=True, timeout=60)
                self.assertEqual(ran.stdout.split(), ['1', 'False'], ran.stderr)
                self.assertEqual(json.loads(ran.stderr),
                                 {'ok': False, 'error': 'Python 3.10 or later is needed (found 3.9)'})

    def test_the_shims_stay_parseable_by_python_3_6(self):
        for path in SHIMS:
            with self.subTest(shim=path.name):
                ast.parse(path.read_text(encoding='utf-8'), filename=str(path), feature_version=(3, 6))


if __name__ == '__main__':
    unittest.main()
