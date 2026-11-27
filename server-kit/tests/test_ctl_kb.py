"""The kb-put verb (kit 2.1): the knowledge-base copy in ~/luady-kb."""
from __future__ import annotations

import json
import os
import stat
import unittest

from luady_kit import kb
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase


def payload(files, prune=False, **extra):
    body = {'files': [{'path': p, 'content': c} for p, c in files], 'prune': prune, **extra}
    return json.dumps(body).encode('utf-8')


class CtlKbPutTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = make_ctx(self.home)
        self.kb = self.home / 'luady-kb'

    def put(self, files, prune=False, **extra):
        return run_ctl(self.ctx, 'kb-put', stdin=payload(files, prune, **extra))

    def assertRefused(self, files, code='usage', prune=False):
        exit_code, out = self.put(files, prune)
        self.assertEqual(out['error']['code'], code, out)
        self.assertNotEqual(exit_code, 0)
        return out['error']['message']

    def tree(self):
        return sorted(str(p.relative_to(self.kb)) for p in self.kb.rglob('*') if p.is_file())

    def test_writes_files_with_modes(self):
        files = [('INDEX.md', '# Index\n'), ('global/rules.md', 'g'), ('orchard/overview.md', 'ü overview'),
                 ('orchard/notes/deep.md', 'deep')]
        self.assertEqual(self.put(files), (0, {'written': 4, 'removed': 0}))
        self.assertEqual(self.tree(), ['INDEX.md', 'global/rules.md', 'orchard/notes/deep.md', 'orchard/overview.md'])
        self.assertEqual((self.kb / 'orchard' / 'overview.md').read_text(encoding='utf-8'), 'ü overview')
        for folder in (self.kb, self.kb / 'orchard', self.kb / 'orchard' / 'notes'):
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700, folder)
        for page in ('INDEX.md', 'orchard/notes/deep.md'):
            self.assertEqual(stat.S_IMODE((self.kb / page).stat().st_mode), 0o600, page)
        self.assertEqual([p.name for p in self.kb.rglob('*.tmp')], [])

    def test_folders_an_older_kit_opened_are_closed_to_others(self):
        (self.kb / 'orchard').mkdir(parents=True)
        for folder in (self.kb, self.kb / 'orchard'):
            folder.chmod(0o755)
        (self.kb / 'INDEX.md').write_text('old', encoding='utf-8')
        (self.kb / 'INDEX.md').chmod(0o644)
        self.assertEqual(self.put([('INDEX.md', 'new'), ('orchard/overview.md', 'o')])[0], 0)
        for path, mode in ((self.kb, 0o700), (self.kb / 'orchard', 0o700), (self.kb / 'INDEX.md', 0o600)):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), mode, path)

    def test_overwrites_and_prunes(self):
        self.put([('INDEX.md', 'a'), ('old/gone.md', 'x'), ('keep/stay.md', 'y'), ('keep/drop.md', 'z')])
        (self.kb / 'keep' / 'notes.txt').write_text('not markdown', encoding='utf-8')
        code, out = self.put([('INDEX.md', 'b'), ('keep/stay.md', 'y2')], prune=True)
        self.assertEqual((code, out), (0, {'written': 2, 'removed': 2}))
        self.assertEqual(self.tree(), ['INDEX.md', 'keep/notes.txt', 'keep/stay.md'])
        self.assertFalse((self.kb / 'old').exists())
        self.assertEqual((self.kb / 'INDEX.md').read_text(encoding='utf-8'), 'b')

    def test_without_prune_nothing_is_removed(self):
        self.put([('a.md', '1')])
        self.assertEqual(self.put([('b.md', '2')]), (0, {'written': 1, 'removed': 0}))
        self.assertEqual(self.tree(), ['a.md', 'b.md'])

    def test_prune_with_an_empty_set_clears_the_folder(self):
        self.put([('x/a.md', '1'), ('b.md', '2')])
        self.assertEqual(self.put([], prune=True), (0, {'written': 0, 'removed': 2}))
        self.assertEqual(list(self.kb.iterdir()), [])

    def test_prune_leaves_symlinks_into_other_folders_alone(self):
        outside = self.home / 'outside'
        outside.mkdir()
        (outside / 'victim.md').write_text('keep', encoding='utf-8')
        self.put([('a.md', '1')])
        os.symlink(outside, self.kb / 'link')
        self.put([('a.md', '1')], prune=True)
        self.assertEqual((outside / 'victim.md').read_text(encoding='utf-8'), 'keep')

    def test_bad_paths_are_refused_and_nothing_is_written(self):
        for bad in ('/etc/x.md', '../x.md', 'a/../x.md', './x.md', 'a/./x.md', 'a//x.md', 'x.txt', 'x', 'a\\b.md',
                    'a/b/c/d.md', 'sp ace.md', '.hidden.md', 'a/', '', 'é.md', 'x' * 81 + '.md', 'a/.md'):
            with self.subTest(path=bad):
                self.assertRefused([('ok.md', 'fine'), (bad, 'bad')])
                self.assertFalse(self.kb.exists())

    def test_shape_errors(self):
        cases = [b'[]', b'{"files": {}}', b'{"files": [1]}', b'{"files": [{"path": "a.md"}]}',
                 b'{"files": [{"path": 1, "content": "x"}]}', b'{"files": [], "prune": "yes"}', b'not json',
                 json.dumps({'files': [{'path': 'a.md', 'content': '1'}, {'path': 'a.md', 'content': '2'}]}).encode()]
        for raw in cases:
            with self.subTest(raw=raw[:40]):
                code, out = run_ctl(self.ctx, 'kb-put', stdin=raw)
                self.assertEqual((code, out['error']['code']), (2, 'usage'))
        self.assertFalse(self.kb.exists())

    def test_prune_defaults_to_false(self):
        self.put([('a.md', '1')])
        code, out = run_ctl(self.ctx, 'kb-put', stdin=b'{"files": []}')
        self.assertEqual((code, out), (0, {'written': 0, 'removed': 0}))
        self.assertEqual(self.tree(), ['a.md'])

    def test_limits(self):
        self.assertRefused([(f'f{i}.md', '') for i in range(kb.MAX_FILES + 1)])
        self.assertEqual(self.put([(f'f{i}.md', '') for i in range(kb.MAX_FILES)])[0], 0)
        code, out = run_ctl(self.ctx, 'kb-put', stdin=b' ' * (kb.MAX_BYTES + 1))
        self.assertEqual((code, out['error']['code']), (2, 'usage'))
        self.assertIn('bytes', out['error']['message'])
        self.assertFalse((self.kb / 'f400.md').exists())

    def test_a_symlinked_root_is_refused(self):
        real = self.home / 'elsewhere'
        real.mkdir()
        os.symlink(real, self.kb)
        message = self.assertRefused([('a.md', '1')], code='refused')
        self.assertIn('symlink', message)
        self.assertEqual(list(real.iterdir()), [])

    def test_a_symlinked_folder_is_refused(self):
        outside = self.home / 'outside'
        outside.mkdir()
        self.kb.mkdir()
        os.symlink(outside, self.kb / 'proj')
        self.assertRefused([('a.md', '1'), ('proj/x.md', '2')], code='refused')
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.kb / 'a.md').exists())

    def test_a_file_where_a_folder_should_be_is_refused(self):
        self.kb.mkdir()
        (self.kb / 'proj').write_text('x', encoding='utf-8')
        self.assertRefused([('proj/x.md', '2')], code='refused')
        (self.kb / 'dir.md').mkdir()
        self.assertRefused([('dir.md', '2')], code='refused')

    def test_root_that_is_a_file_is_refused(self):
        self.kb.write_text('x', encoding='utf-8')
        self.assertRefused([('a.md', '1')], code='refused')

    def test_existing_symlinked_target_file_is_replaced_not_followed(self):
        outside = self.home / 'victim.md'
        outside.write_text('keep', encoding='utf-8')
        self.kb.mkdir()
        os.symlink(outside, self.kb / 'a.md')
        self.assertEqual(self.put([('a.md', 'new')])[0], 0)
        self.assertEqual(outside.read_text(encoding='utf-8'), 'keep')
        self.assertFalse((self.kb / 'a.md').is_symlink())

    def test_a_write_failure_is_reported(self):
        self.kb.mkdir()
        (self.kb / 'ro').mkdir()
        (self.kb / 'ro').chmod(0o555)
        try:
            if os.access(self.kb / 'ro', os.W_OK):
                self.skipTest('running as root: permissions are not enforced')
            code, out = self.put([('ro/a.md', '1')])
            self.assertEqual(out['error']['code'], 'failed')
        finally:
            (self.kb / 'ro').chmod(0o755)


if __name__ == '__main__':
    unittest.main()
