"""graphify-run and graph-query verbs: clean env, caps, report summary, refusals."""
from __future__ import annotations

from pathlib import Path

from luady_kit import common, graph
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase

REPORT = """# Graph Report - shop  (2026-10-10)

## Corpus Check
- 12 files

## Summary
- 40 nodes · 90 edges

## Community Hubs (Navigation)
- colors.dart
- main.dart

## God Nodes (most connected - your core abstractions)
1. `CartService` - 22 edges

## Communities (3 total)
### Community 0 - "colors.dart"
"""


class GraphTest(HomeTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.calls: list[list[str]] = []
        self.project = self.home / 'projects' / 'shop'
        (self.project / '.git').mkdir(parents=True)
        bin_dir = self.home / '.local' / 'bin'
        bin_dir.mkdir(parents=True)
        (bin_dir / 'graphify').write_text('#!/bin/sh\n', encoding='utf-8')

    def ctx(self, result: common.RunResult):
        def fake_run(argv, input_bytes=None, timeout=10.0, cwd=None):
            if argv[0] == 'git':
                return common.RunResult(0, b'.git/info/exclude\n', b'')
            self.calls.append(list(argv))
            if 'update' in argv:
                (self.project / 'graphify-out').mkdir(exist_ok=True)
                (self.project / 'graphify-out' / 'GRAPH_REPORT.md').write_text(REPORT, encoding='utf-8')
            return result
        return make_ctx(self.home, run=fake_run)

    def test_run_builds_in_a_clean_env_and_returns_the_report_summary(self):
        ctx = self.ctx(common.RunResult(0, b'AST extraction: 12/12\nCode graph updated.\n', b''))
        code, out = run_ctl(ctx, 'graphify-run', '--path', str(self.project), '--timeout', '900')
        self.assertEqual(code, 0)
        argv = self.calls[0]
        self.assertIn('env', argv)
        self.assertIn('PATH=/usr/bin:/bin', argv)
        self.assertEqual(argv[-2:], ['update', str(self.project)])
        self.assertIn('# Graph Report - shop', out['report'])
        self.assertIn('## God Nodes', out['report'])
        self.assertNotIn('Community Hubs', out['report'])
        self.assertNotIn('Community 0', out['report'])
        self.assertIn('graphify-out/', (self.project / '.git' / 'info' / 'exclude').read_text(encoding='utf-8'))
        run_ctl(ctx, 'graphify-run', '--path', str(self.project), '--timeout', '900')
        self.assertEqual((self.project / '.git' / 'info' / 'exclude').read_text(encoding='utf-8').count('graphify-out'), 1)

    def test_run_reports_failures_and_refuses_paths_outside_projects(self):
        ctx = self.ctx(common.RunResult(1, b'', b'boom'))
        code, out = run_ctl(ctx, 'graphify-run', '--path', str(self.project), '--timeout', '900')
        self.assertEqual((code, out['error']['code']), (1, 'failed'))
        code, out = run_ctl(ctx, 'graphify-run', '--path', str(self.home), '--timeout', '900')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))
        self.assertEqual(len(self.calls), 1)

    def test_query_needs_a_built_graph_and_passes_the_question_as_one_argument(self):
        ctx = self.ctx(common.RunResult(0, b'CartService -> PaymentGateway\n', b''))
        code, out = run_ctl(ctx, 'graph-query', '--path', str(self.project), '--budget', '1500', stdin=b'how does checkout work?')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        (self.project / 'graphify-out').mkdir()
        (self.project / 'graphify-out' / 'graph.json').write_text('{}', encoding='utf-8')
        code, out = run_ctl(ctx, 'graph-query', '--path', str(self.project), '--budget', '1500', stdin=b'how does checkout work?')
        self.assertEqual((code, out['text']), (0, 'CartService -> PaymentGateway'))
        argv = self.calls[-1]
        self.assertEqual(argv[argv.index('query') + 1], 'how does checkout work?')
        self.assertEqual(argv[-2:], ['--budget', '1500'])
        code, out = run_ctl(ctx, 'graph-query', '--path', str(self.project), '--budget', '1500', stdin=b'  ')
        self.assertEqual((code, out['error']['code']), (2, 'usage'))

    def test_report_summary_caps_its_size(self):
        long_report = '# T\n## Summary\n' + ('x' * 100 + '\n') * 500
        self.assertLessEqual(len(graph.report_summary(long_report)), graph.REPORT_HEAD_MAX + 20)


if __name__ == '__main__':  # pragma: no cover
    import unittest
    unittest.main()
