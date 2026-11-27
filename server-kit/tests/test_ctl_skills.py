"""The skills verb (kit 2.1): user, project and plug-in skills with their front matter."""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

from luady_kit import skills
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase


def write_skill(folder: Path, text: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / 'SKILL.md'
    path.write_text(text, encoding='utf-8')
    return path


def front(name: str, description: str) -> str:
    return f'---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n'


class FrontMatterTest(unittest.TestCase):
    def test_plain_values(self):
        self.assertEqual(skills.parse_front_matter('---\nname: deploy\ndescription: Ships it: fast\n---\nbody'),
                         {'name': 'deploy', 'description': 'Ships it: fast'})

    def test_quoted_values(self):
        text = '---\nname: "say \\"hi\\""\ndescription: \'it\'\'s quoted\'\n---\n'
        self.assertEqual(skills.parse_front_matter(text), {'name': 'say "hi"', 'description': "it's quoted"})

    def test_folded_and_literal_block_scalars(self):
        text = ('---\nname: x\ndescription: >\n  first line\n  second line\n\n  after blank\n'
                'other: |\n  keep\n  lines\nlast: >-\n  cut\n---\n')
        parsed = skills.parse_front_matter(text)
        self.assertEqual(parsed['description'], 'first line second line\nafter blank')
        self.assertEqual(parsed['other'], 'keep\nlines')
        self.assertEqual(parsed['last'], 'cut')

    def test_plain_multiline_continuation_and_crlf(self):
        text = '---\r\nname: x\r\ndescription: starts here\r\n  and goes on\r\n---\r\n'
        self.assertEqual(skills.parse_front_matter(text)['description'], 'starts here and goes on')

    def test_no_or_unterminated_front_matter(self):
        self.assertEqual(skills.parse_front_matter('# just markdown\nname: x\n'), {})
        self.assertEqual(skills.parse_front_matter('---\nname: x\n'), {})
        self.assertEqual(skills.parse_front_matter(''), {})

    def test_bad_quotes_and_comments_and_odd_lines(self):
        text = '---\n# a comment\nname: "unclosed\n- list item\n: nokey\ndescription:\n---\n'
        parsed = skills.parse_front_matter(text)
        self.assertEqual(parsed['name'], '"unclosed')
        self.assertEqual(parsed['description'], '')


class CtlSkillsTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.ctx = make_ctx(self.home)
        self.user = self.home / '.claude' / 'skills'
        self.plugins = self.home / '.claude' / 'plugins'

    def skills(self):
        code, out = run_ctl(self.ctx, 'skills')
        self.assertEqual(code, 0, out)
        return out['skills']

    def test_empty_home_lists_nothing(self):
        self.assertEqual(self.skills(), [])

    def test_user_skills_with_fallbacks_and_symlinks(self):
        deploy = write_skill(self.user / 'deploy', front('deploy-it', 'Ships the app.'))
        write_skill(self.user / 'bare', '# no front matter\n')
        target = write_skill(self.home / '.agents' / 'skills' / 'linked', front('linked', 'Via a link.'))
        os.symlink(target.parent, self.user / 'linked')
        os.symlink(self.user, self.user / 'loop')  # a link back to the folder: no SKILL.md, never recursed
        (self.user / 'README.md').write_text('not a skill', encoding='utf-8')
        (self.user / 'empty').mkdir()
        rows = self.skills()
        self.assertEqual([(r['name'], r['description'], r['source']) for r in rows],
                         [('bare', '', 'user'), ('deploy-it', 'Ships the app.', 'user'), ('linked', 'Via a link.', 'user')])
        self.assertEqual(rows[1]['path'], str(deploy))
        self.assertEqual(rows[2]['path'], str(self.user / 'linked' / 'SKILL.md'))

    def test_project_skills_for_the_repos_the_projects_verb_finds(self):
        app = self.home / 'projects' / 'app'
        (app / '.git').mkdir(parents=True)
        nested = self.home / 'projects' / 'clients' / 'harbor'
        (nested / '.git').mkdir(parents=True)
        write_skill(app / '.claude' / 'skills' / 'migrate', front('migrate', 'Runs migrations.'))
        write_skill(nested / '.claude' / 'skills' / 'seed', front('seed', 'Seeds data.'))
        write_skill(self.home / 'projects' / 'notarepo' / '.claude' / 'skills' / 'x', front('x', 'no'))
        rows = self.skills()
        self.assertEqual([(r['name'], r['source']) for r in rows], [('migrate', 'project'), ('seed', 'project')])

    def test_plugin_skills_newest_version_once(self):
        old = write_skill(self.plugins / 'cache' / 'mkt' / 'tools' / '1.0.0' / 'skills' / 'lint', front('lint', 'Old.'))
        new = write_skill(self.plugins / 'cache' / 'mkt' / 'tools' / '1.1.0' / 'skills' / 'lint', front('lint', 'New.'))
        os.utime(old, (1_000_000, 1_000_000))
        os.utime(new, (2_000_000, 2_000_000))
        write_skill(self.plugins / 'cache' / 'mkt' / 'tools' / '1.0.0' / 'skills' / 'gone', front('gone', 'Only old.'))
        write_skill(self.plugins / 'cache' / 'other' / 'web' / '2.0.0' / 'skills' / 'lint', front('lint', 'Web lint.'))
        write_skill(self.plugins / 'marketplaces' / 'mkt' / 'plugins' / 'x' / 'skills' / 'catalog',
                    front('catalog', 'Not installed.'))
        write_skill(self.plugins / 'cache' / 'a' / 'b' / 'c' / 'd' / 'e' / 'f' / 'skills' / 'deep', front('deep', 'Too deep.'))
        os.symlink(self.plugins, self.plugins / 'cache' / 'loop')
        rows = self.skills()
        self.assertEqual(sorted((r['name'], r['description']) for r in rows),
                         [('gone', 'Only old.'), ('lint', 'New.'), ('lint', 'Web lint.')])
        self.assertTrue(all(r['source'] == 'plugin' for r in rows))
        self.assertIn(str(new), [r['path'] for r in rows])

    def test_order_limits_and_unreadable_files(self):
        write_skill(self.user / 'long', front('long', 'd' * 400))
        write_skill(self.user / 'multi', '---\nname: multi\ndescription: >\n  a\n   b\tc\n---\n')
        broken = self.user / 'broken'
        broken.mkdir()
        (broken / 'SKILL.md').write_bytes(b'---\nname: \xff\xfe\n---\n')
        rows = {r['name']: r for r in self.skills()}
        self.assertEqual(len(rows['long']['description']), 300)
        self.assertTrue(rows['long']['description'].endswith('…'))
        self.assertEqual(rows['multi']['description'], 'a b c')
        self.assertIn('broken', [r['path'].split('/')[-2] for r in rows.values()])

    def test_sources_come_user_then_project_then_plugin(self):
        write_skill(self.plugins / 'cache' / 'm' / 'p' / '1' / 'skills' / 'a', front('a', 'plugin'))
        app = self.home / 'projects' / 'app'
        (app / '.git').mkdir(parents=True)
        write_skill(app / '.claude' / 'skills' / 'b', front('b', 'project'))
        write_skill(self.user / 'c', front('c', 'user'))
        self.assertEqual([r['source'] for r in self.skills()], ['user', 'project', 'plugin'])

    def test_at_most_300_skills(self):
        for index in range(310):
            write_skill(self.user / f's{index:03d}', front(f's{index:03d}', 'x'))
        rows = self.skills()
        self.assertEqual(len(rows), 300)
        self.assertEqual(rows[0]['name'], 's000')

    def test_unreadable_skill_is_skipped(self):
        path = write_skill(self.user / 'secret', front('secret', 'x'))
        path.chmod(0)
        try:
            if os.access(path, os.R_OK):
                self.skipTest('running as root: permissions are not enforced')
            self.assertEqual(self.skills(), [])
        finally:
            path.chmod(0o644)


if __name__ == '__main__':
    unittest.main()
