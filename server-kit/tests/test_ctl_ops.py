"""exec, file-read and file-write verbs: caps, timeouts, atomic writes and the deny list."""
from __future__ import annotations

import base64
import os
import stat
import time
import unittest
from pathlib import Path

from luady_kit import common, ops
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase


class CtlExecTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = make_ctx(self.home)

    def run_exec(self, command, timeout='10', cwd=None):
        return run_ctl(self.ctx, 'exec', '--cwd', cwd or str(self.home), '--timeout', timeout,
                       stdin=command.encode('utf-8'))

    def test_runs_in_cwd_with_exit_code_and_both_streams(self):
        code, out = self.run_exec('pwd; echo "مرحبا $((6 * 7))"; echo oops >&2; exit 3')
        self.assertEqual(code, 0)
        self.assertEqual(out, {'exit': 3, 'stdout': f'{self.home}\nمرحبا 42\n', 'stderr': 'oops\n',
                               'truncated': False, 'timed_out': False})

    def test_output_is_capped_per_stream(self):
        _, out = self.run_exec("head -c 70000 /dev/zero | tr '\\0' a; head -c 70000 /dev/zero | tr '\\0' b >&2")
        self.assertEqual((len(out['stdout']), len(out['stderr']), out['truncated']), (65536, 65536, True))

    def test_cap_never_splits_a_utf8_character(self):
        _, out = self.run_exec("printf 'a'; for i in $(seq 1 40000); do printf 'م'; done")
        self.assertTrue(out['truncated'])
        self.assertNotIn('�', out['stdout'])
        self.assertEqual(len(out['stdout'].encode('utf-8')), 65535)

    def test_timeout_kills_the_process_group(self):
        started = time.monotonic()
        _, out = self.run_exec('sleep 30 & sleep 30; echo never', timeout='1')
        self.assertLess(time.monotonic() - started, 10)
        self.assertTrue(out['timed_out'])
        self.assertNotIn('never', out['stdout'])

    def test_exec_validation(self):
        self.assertEqual(self.run_exec('   ')[1]['error']['code'], 'usage')
        self.assertEqual(self.run_exec('echo a\x00b')[1]['error']['code'], 'usage')
        code, out = self.run_exec('true', cwd='/nonexistent-dir')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))


class CtlFileTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = make_ctx(self.home)
        (self.home / '.ssh').mkdir()
        (self.home / '.ssh' / 'id_ed25519').write_text('PRIVATE', encoding='utf-8')
        (self.home / '.claude').mkdir()
        (self.home / '.claude' / '.credentials.json').write_text('{"token": "x"}', encoding='utf-8')
        common.answer_path(self.paths, 'AAAAAAAA').write_text('{}', encoding='utf-8')
        self.work = self.home / 'projects' / 'app'
        self.work.mkdir(parents=True)

    def test_read_and_write_round_trip(self):
        target = self.work / 'notes.md'
        content = 'سطر 1\n`x` $(y)\n'.encode('utf-8')
        self.assertEqual(run_ctl(self.ctx, 'file-write', '--path', str(target), stdin=content),
                         (0, {'ok': True, 'bytes': len(content)}))
        code, out = run_ctl(self.ctx, 'file-read', '--path', str(target), '--max', '1000')
        self.assertEqual((code, out), (0, {'path': str(target), 'size': len(content),
                                           'content': content.decode('utf-8'), 'truncated': False}))

    def test_file_get_returns_base64_and_refuses_oversize(self):
        target = self.work / 'shot.png'
        target.write_bytes(bytes(range(256)))
        code, out = run_ctl(self.ctx, 'file-get', '--path', str(target), '--max', '1000')
        self.assertEqual((code, out['size'], base64.b64decode(out['b64'])), (0, 256, bytes(range(256))))
        code, out = run_ctl(self.ctx, 'file-get', '--path', str(target), '--max', '10')
        self.assertEqual((code, out['error']['code']), (2, 'usage'))
        code, out = run_ctl(self.ctx, 'file-get', '--path', str(self.home / '.ssh' / 'id_ed25519'), '--max', '100')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))

    def test_file_put_writes_into_the_inbox_without_overwriting(self):
        payload = base64.b64encode(b'%PDF-1.7 data')
        code, out = run_ctl(self.ctx, 'file-put', '--name', 'report.pdf', stdin=payload)
        self.assertEqual((code, out), (0, {'path': str(self.home / 'luady-inbox' / 'report.pdf'), 'size': 13}))
        code, out = run_ctl(self.ctx, 'file-put', '--name', 'report.pdf', stdin=payload)
        self.assertEqual(out['path'], str(self.home / 'luady-inbox' / 'report-1.pdf'))
        self.assertEqual((self.home / 'luady-inbox' / 'report-1.pdf').read_bytes(), b'%PDF-1.7 data')
        inbox = self.home / 'luady-inbox'
        self.assertEqual((stat.S_IMODE(inbox.stat().st_mode), stat.S_IMODE((inbox / 'report.pdf').stat().st_mode)),
                         (0o700, 0o600))
        inbox.chmod(0o750)
        run_ctl(self.ctx, 'file-put', '--name', 'again.pdf', stdin=payload)
        self.assertEqual(stat.S_IMODE(inbox.stat().st_mode), 0o700)
        for bad in ('../x', '.hidden', 'a/b', 'a..b', 'a.txt\n'):
            code, out = run_ctl(self.ctx, 'file-put', '--name', bad, stdin=payload)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), bad)
        code, out = run_ctl(self.ctx, 'file-put', '--name', 'x.bin', stdin=b'not base64!!')
        self.assertEqual((code, out['error']['code']), (2, 'usage'))

    def test_read_truncates_at_max(self):
        target = self.work / 'big.txt'
        target.write_bytes(b'x' * 100)
        _, out = run_ctl(self.ctx, 'file-read', '--path', str(target), '--max', '10')
        self.assertEqual((out['content'], out['size'], out['truncated']), ('x' * 10, 100, True))

    def test_write_is_atomic_and_keeps_mode(self):
        target = self.work / 'run.sh'
        target.write_text('old', encoding='utf-8')
        target.chmod(0o750)
        run_ctl(self.ctx, 'file-write', '--path', str(target), stdin=b'new')
        self.assertEqual((target.read_bytes(), stat.S_IMODE(target.stat().st_mode)), (b'new', 0o750))
        self.assertEqual(sorted(p.name for p in self.work.iterdir()), ['run.sh'])

    def test_a_new_file_follows_the_users_umask(self):
        for umask, mode in ((0o077, 0o600), (0o022, 0o644), (0o002, 0o664)):
            target = self.work / f'new-{umask:o}.env'
            previous = os.umask(umask)
            try:
                self.assertEqual(run_ctl(self.ctx, 'file-write', '--path', str(target), stdin=b'K=1\n')[0], 0)
            finally:
                os.umask(previous)
            with self.subTest(umask=oct(umask)):
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)

    def test_write_through_symlink_updates_the_target(self):
        real = self.work / 'real.txt'
        real.write_text('a', encoding='utf-8')
        link = self.work / 'link.txt'
        link.symlink_to(real)
        run_ctl(self.ctx, 'file-write', '--path', str(link), stdin=b'b')
        self.assertTrue(link.is_symlink())
        self.assertEqual(real.read_bytes(), b'b')

    def test_deny_list_refuses_reads_and_writes(self):
        denied = [self.home / '.ssh' / 'id_ed25519', self.home / '.ssh', self.home / '.claude' / '.credentials.json',
                  common.answer_path(self.paths, 'AAAAAAAA'), Path('/etc/shadow'), Path('/etc/sudoers'),
                  Path('/etc/sudoers.d/90-x')]
        for path in denied:
            code, out = run_ctl(self.ctx, 'file-read', '--path', str(path), '--max', '100')
            self.assertEqual((code, out['error']['code']), (3, 'refused'), path)
            code, out = run_ctl(self.ctx, 'file-write', '--path', str(path), stdin=b'x')
            self.assertEqual((code, out['error']['code']), (3, 'refused'), path)
        self.assertEqual((self.home / '.ssh' / 'id_ed25519').read_text(encoding='utf-8'), 'PRIVATE')

    def test_credentials_the_hub_and_the_kit_state_are_denied(self):
        home = self.home
        denied = [home / '.luady' / 'pending' / 'ABCDEFGH.json', home / '.aws' / 'credentials', home / '.git-credentials',
                  home / '.netrc', home / '.claude.json', home / '.config' / 'gh' / 'hosts.yml', home / '.npmrc',
                  home / '.docker' / 'config.json', home / '.kube' / 'config', home / '.config' / 'luady' / 'secrets.env',
                  home / '.local' / 'share' / 'luady' / 'data' / 'hub.db', home / '.local' / 'state' / 'luady' / 'x',
                  Path('/proc/self/environ'), Path(f'/proc/{os.getpid()}/environ')]
        for path in denied:
            code, out = run_ctl(self.ctx, 'file-read', '--path', str(path), '--max', '100')
            self.assertEqual((code, out['error']['code']), (3, 'refused'), path)
            code, out = run_ctl(self.ctx, 'file-write', '--path', str(path), stdin=b'x')
            self.assertEqual((code, out['error']['code']), (3, 'refused'), path)
        self.write_config(host_alias='cedar')
        config = self.paths.config_file
        self.assertEqual(run_ctl(self.ctx, 'file-read', '--path', str(config), '--max', '10000')[0], 0)
        code, out = run_ctl(self.ctx, 'file-write', '--path', str(config), stdin=b'{"claude_bin": "/tmp/x"}')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))
        link = self.work / 'settings-link.json'
        link.symlink_to(config)
        code, out = run_ctl(self.ctx, 'file-write', '--path', str(link), stdin=b'{}')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))

    def test_the_xdg_folders_of_the_hub_are_denied_where_they_are(self):
        environ = {'XDG_CONFIG_HOME': '/srv/cfg', 'XDG_DATA_HOME': '/srv/data', 'XDG_STATE_HOME': 'relative/ignored'}
        for path in ('/srv/cfg/luady/config.json', '/srv/data/luady/data/hub.db', '/srv/cfg/gh/hosts.yml',
                     '/home/dev/.config/luady/secrets.env'):
            self.assertIsNotNone(ops.denied_reason(path, '/home/dev', environ=environ), path)
        for path in ('/srv/cfg/other/x', '/srv/data/luady-notes.txt', 'relative/ignored/luady/x', '/srv/cfg/gh/config.yml'):
            self.assertIsNone(ops.denied_reason(path, '/home/dev', environ=environ), path)

    def test_deny_list_cannot_be_bypassed(self):
        link = self.work / 'innocent.txt'
        link.symlink_to(self.home / '.ssh' / 'id_ed25519')
        for path in (str(link), f'{self.work}/../../.ssh/id_ed25519', f'/{self.home}/.ssh/id_ed25519',
                     f'{self.home}/./.claude/.credentials.json'):
            code, out = run_ctl(self.ctx, 'file-read', '--path', path, '--max', '100')
            self.assertEqual((code, out['error']['code']), (3, 'refused'), path)

    def test_missing_and_non_regular_files(self):
        code, out = run_ctl(self.ctx, 'file-read', '--path', str(self.work / 'none.txt'), '--max', '10')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        code, out = run_ctl(self.ctx, 'file-read', '--path', str(self.work), '--max', '10')
        self.assertEqual((code, out['error']['code']), (2, 'usage'))
        os.mkfifo(self.work / 'pipe')
        code, out = run_ctl(self.ctx, 'file-read', '--path', str(self.work / 'pipe'), '--max', '10')
        self.assertEqual((code, out['error']['code']), (2, 'usage'))
        code, out = run_ctl(self.ctx, 'file-write', '--path', str(self.work / 'nodir' / 'x.txt'), stdin=b'x')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        code, out = run_ctl(self.ctx, 'file-write', '--path', str(self.work), stdin=b'x')
        self.assertEqual((code, out['error']['code']), (2, 'usage'))

    def test_denied_reason_helper(self):
        self.assertIsNone(ops.denied_reason('/etc/hosts', '/home/dev'))
        self.assertIsNotNone(ops.denied_reason('/home/dev/.luady/answers', '/home/dev'))
        self.assertIsNotNone(ops.denied_reason('/home/dev/.luady/pending/x.json', '/home/dev'))
        self.assertIsNone(ops.denied_reason('/home/dev/.sshkeys', '/home/dev'))
        self.assertIsNotNone(ops.denied_reason('/etc/gshadow', '/home/dev'))
        self.assertIsNone(ops.denied_reason('/home/dev/.luady/state/config.json', '/home/dev', environ={}))
        self.assertIsNotNone(ops.denied_reason('/home/dev/.luady/state/config.json', '/home/dev', write=True, environ={}))
        self.assertIsNone(ops.denied_reason('/proc/cpuinfo', '/home/dev'))
        self.assertIsNotNone(ops.denied_reason('/proc/1/task/1/environ', '/home/dev'))
        self.assertIsNone(ops.denied_reason('/home/dev/projects/app/.netrc.example', '/home/dev'))


if __name__ == '__main__':
    unittest.main()
