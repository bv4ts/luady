"""Step summaries: titles, line counts, to-do items, ok/failed and the activity event shapes."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from luady_kit import steps
from luady_kit.redact import utf16_len

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 's3'
HOME = '/home/dev'
CWD = '/home/dev/projects/app'
STEP_KEYS = {'tool', 'title', 'tool_use_id', 'agent_id', 'agent_type'}
END_KEYS = STEP_KEYS | {'ok', 'added', 'removed'}
HELPER_KEYS = {'agent_id', 'agent_type'}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f'{name}.json').read_text(encoding='utf-8'))


def title(tool: str, tool_input) -> str:
    return steps.step_title(tool, tool_input, CWD, HOME)


class RelPathTest(unittest.TestCase):
    def test_inside_cwd_home_and_elsewhere(self):
        self.assertEqual(steps.rel_path('/home/dev/projects/app/src/a.ts', CWD, HOME), 'src/a.ts')
        self.assertEqual(steps.rel_path('/home/dev/projects/other/b.ts', CWD, HOME), '~/projects/other/b.ts')
        self.assertEqual(steps.rel_path('/etc/hosts', CWD, HOME), '/etc/hosts')
        self.assertEqual(steps.rel_path('/home/dev/projects/app', CWD, HOME), '.')
        self.assertEqual(steps.rel_path('/home/dev/projects/apple/x', CWD + '/', HOME), '~/projects/apple/x')
        self.assertEqual(steps.rel_path('/home/dev/a', None, HOME), '~/a')


class TitleTest(unittest.TestCase):
    def test_file_tools_use_the_relative_path(self):
        for tool, key in (('Read', 'file_path'), ('Edit', 'file_path'), ('Write', 'file_path'),
                          ('MultiEdit', 'file_path'), ('NotebookEdit', 'notebook_path'),
                          ('NotebookRead', 'notebook_path'), ('LS', 'path')):
            self.assertEqual(title(tool, {key: f'{CWD}/src/a.ts', 'content': 'secret body'}), 'src/a.ts', tool)

    def test_bash_first_non_empty_line(self):
        self.assertEqual(title('Bash', {'command': '\n  npm test  \nnpm run build'}), 'npm test')
        self.assertEqual(title('Bash', {'command': 'API_KEY=abcd1234 npm run deploy'}), 'API_KEY=[redacted] npm run deploy')
        self.assertEqual(title('Bash', {'command': 'GITHUB_TOKEN=ghp_x; git push --force'}),
                         'GITHUB_TOKEN=[redacted]; git push --force')

    def test_long_titles_are_cut_to_160(self):
        out = title('Bash', {'command': 'echo ' + 'word ' * 80})
        self.assertEqual(len(out), 160)
        self.assertTrue(out.endswith('…'))
        wide = title('Bash', {'command': 'echo ' + '😀' * 200})
        self.assertLessEqual(utf16_len(wide), steps.TITLE_MAX)

    def test_search_tools(self):
        self.assertEqual(title('Grep', {'pattern': 'TODO', 'path': f'{CWD}/src'}), 'TODO in src')
        self.assertEqual(title('Grep', {'pattern': 'TODO'}), 'TODO')
        self.assertEqual(title('Glob', {'pattern': '**/*.ts'}), '**/*.ts')
        self.assertEqual(title('ToolSearch', {'query': 'select:WebFetch'}), 'select:WebFetch')
        self.assertEqual(title('WebSearch', {'query': 'tmux 3.4 changelog'}), 'tmux 3.4 changelog')

    def test_web_fetch_keeps_host_and_path_only(self):
        url = 'https://bob:pw@docs.example.test:8443/a/b?token=abc#frag'
        self.assertEqual(title('WebFetch', {'url': url, 'prompt': 'x'}), 'docs.example.test:8443/a/b')
        self.assertEqual(title('WebFetch', {'url': 'https://example.com'}), 'example.com')
        self.assertEqual(title('WebFetch', {'url': 'http://[::1'}), '')

    def test_skill_agent_and_mcp(self):
        self.assertEqual(title('Skill', {'skill': 'superpowers:brainstorming'}), 'superpowers:brainstorming')
        self.assertEqual(title('Skill', {'command': 'review'}), 'review')
        self.assertEqual(title('Agent', {'subagent_type': 'Explore', 'description': 'Count files\nmore'}),
                         'Explore: Count files')
        self.assertEqual(title('Task', {'subagent_type': 'general-purpose'}), 'general-purpose')
        self.assertEqual(title('Agent', {'description': 'Find it'}), 'Find it')
        self.assertEqual(title('mcp__jira__search_issues', {'jql': 'x', 'token': 'ghp_' + 'a' * 30}),
                         'jira: search_issues')
        self.assertEqual(title('mcp__solo', {'q': 1}), 'solo')

    def test_todo_tools(self):
        self.assertEqual(title('TodoWrite', {'todos': [{'content': 'a', 'status': 'pending'}] * 3}), '3 items')
        self.assertEqual(title('TaskCreate', {'subject': 'Write the tests'}), 'Write the tests')
        self.assertEqual(title('TaskUpdate', {'taskId': '7', 'status': 'completed'}), 'task 7 → completed')
        self.assertEqual(title('TaskUpdate', {'taskId': 7}), 'task 7')

    def test_unknown_tools_and_bad_input(self):
        self.assertEqual(title('ListAgents', {'x': 1}), '')
        for bad in (None, 'text', [1, 2], 42):
            self.assertEqual(title('Bash', bad), '')
            self.assertEqual(title('WebFetch', bad), '')


class LineCountTest(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(steps.line_counts('Edit', {'old_string': 'a\nb', 'new_string': 'a\nb\nc\n'}), (3, 2))
        self.assertEqual(steps.line_counts('Write', {'content': 'a\nb\nc'}), (3, None))
        self.assertEqual(steps.line_counts('Write', {'content': ''}), (0, None))
        edits = [{'old_string': 'a', 'new_string': 'a\nb'}, {'old_string': 'x\ny\nz', 'new_string': ''}]
        self.assertEqual(steps.line_counts('MultiEdit', {'edits': edits}), (2, 4))
        self.assertEqual(steps.line_counts('NotebookEdit', {'new_source': 'print(1)\n'}), (1, None))
        self.assertEqual(steps.line_counts('Read', {'file_path': '/a'}), (None, None))
        self.assertEqual(steps.line_counts('Edit', None), (None, None))
        self.assertEqual(steps.line_counts('MultiEdit', {'edits': 'bad'}), (0, 0))


class TodoTest(unittest.TestCase):
    def test_todo_write_replaces_and_caps(self):
        todos = [{'content': f'step {i}', 'status': 'pending', 'activeForm': 'x'} for i in range(25)]
        todos[0] = {'content': 'bad', 'status': 'blocked'}
        items, mode = steps.todo_items('TodoWrite', {'todos': todos}, {})
        self.assertEqual((len(items), mode), (20, 'replace'))
        self.assertEqual(items[0], {'id': None, 'subject': 'step 1', 'status': 'pending'})
        self.assertEqual(steps.todo_items('TodoWrite', {'todos': []}, {}), ([], 'replace'))
        self.assertIsNone(steps.todo_items('TodoWrite', {'todos': 'x'}, {}))

    def test_subjects_are_redacted_and_cut(self):
        items, _ = steps.todo_items('TodoWrite', {'todos': [{'content': 'set API_KEY=abc ' + 'x' * 300,
                                                             'status': 'in_progress'}]}, {})
        self.assertTrue(items[0]['subject'].startswith('set API_KEY=[redacted] '))
        self.assertEqual(utf16_len(items[0]['subject']), steps.TODO_SUBJECT_MAX)

    def test_create_and_update_merge(self):
        created = steps.todo_items('TaskCreate', {'subject': 'Write docs'}, {'task': {'id': 'T1', 'subject': 'Write docs'}})
        self.assertEqual(created, ([{'id': 'T1', 'subject': 'Write docs', 'status': 'pending'}], 'merge'))
        self.assertEqual(steps.todo_items('TaskCreate', {'subject': 'A'}, {'taskId': 3})[0][0]['id'], '3')
        updated = steps.todo_items('TaskUpdate', {'taskId': 'T1', 'status': 'completed'}, {})
        self.assertEqual(updated, ([{'id': 'T1', 'subject': '', 'status': 'completed'}], 'merge'))
        self.assertIsNone(steps.todo_items('TaskUpdate', {'taskId': 'T1', 'status': 'deleted'}, {}))
        self.assertIsNone(steps.todo_items('Bash', {'command': 'ls'}, {}))
        self.assertIsNone(steps.todo_items('TaskCreate', 'bad', None))

    def test_recorded_calls_of_other_tools_give_no_todo_items(self):
        for name in ('Bash', 'Write', 'Edit', 'ToolSearch', 'WebFetch', 'Agent'):
            post = fixture(f'PostToolUse-{name}')
            self.assertIsNone(steps.todo_items(name, post['tool_input'], post['tool_response']), name)


class StepOkTest(unittest.TestCase):
    def test_ok_and_failed(self):
        self.assertTrue(steps.step_ok(fixture('PostToolUse-Bash')))
        self.assertFalse(steps.step_ok(fixture('PostToolUseFailure-Bash')))
        self.assertFalse(steps.step_ok({'hook_event_name': 'PostToolUse', 'tool_response': {'interrupted': True}}))
        self.assertFalse(steps.step_ok({'hook_event_name': 'PostToolUse', 'tool_response': {'is_error': True}}))
        self.assertFalse(steps.step_ok({'hook_event_name': 'PostToolUse', 'tool_response': {'error': 'boom'}}))
        self.assertTrue(steps.step_ok({'hook_event_name': 'PostToolUse', 'tool_response': 'text'}))


class BuildStepTest(unittest.TestCase):
    def build(self, payload):
        return steps.build_step(payload, HOME)

    def test_every_fixture_matches_the_b1_shapes(self):
        expected = {'PreToolUse': ('tool_start', STEP_KEYS), 'PostToolUse': ('tool_end', END_KEYS),
                    'PostToolUseFailure': ('tool_end', END_KEYS), 'SubagentStart': ('subagent_start', HELPER_KEYS),
                    'SubagentStop': ('subagent_stop', HELPER_KEYS)}
        seen = set()
        for path in sorted(FIXTURES.glob('*.json')):
            payload = json.loads(path.read_text(encoding='utf-8'))
            result = self.build(payload)
            name = payload['hook_event_name']
            if path.stem == 'SubagentStop-prompt-suggestion' or name not in expected:
                self.assertIsNone(result, path.stem)
                continue
            event, keys = expected[name]
            self.assertEqual(result[0], event, path.stem)
            self.assertEqual(set(result[1]), keys, path.stem)
            seen.add(name)
        self.assertEqual(seen, set(expected))

    def test_tool_start_and_end_values(self):
        self.assertEqual(self.build(fixture('PreToolUse-Bash')), ('tool_start', {
            'tool': 'Bash', 'title': 'echo ok', 'tool_use_id': 'TOOL_USE_ID', 'agent_id': None, 'agent_type': None}))
        event, data = self.build(fixture('PostToolUse-Edit'))
        self.assertEqual((event, data['title'], data['ok'], data['added'], data['removed']),
                         ('tool_end', 'notes.txt', True, 1, 1))
        failed = self.build(fixture('PostToolUseFailure-Bash'))[1]
        self.assertEqual((failed['title'], failed['ok'], failed['added'], failed['removed']), ('false', False, None, None))

    def test_helper_ids_are_kept(self):
        data = self.build(fixture('PostToolUse-Bash-in-subagent'))[1]
        self.assertEqual((data['agent_id'], data['agent_type']), ('AGENT_ID', 'Explore'))
        self.assertEqual(self.build(fixture('SubagentStart')), ('subagent_start', {'agent_id': 'AGENT_ID', 'agent_type': 'Explore'}))
        self.assertEqual(self.build(fixture('SubagentStop'))[0], 'subagent_stop')
        self.assertEqual(self.build(fixture('PostToolUse-Agent'))[1]['title'], 'Explore: <text>')

    def test_helpers_without_id_or_with_an_empty_type_are_ignored(self):
        self.assertIsNone(self.build({**fixture('SubagentStart'), 'agent_id': None}))
        self.assertIsNone(self.build(fixture('SubagentStop-prompt-suggestion')))
        self.assertEqual(self.build({**fixture('SubagentStart'), 'agent_type': None})[1]['agent_type'], None)

    def test_todos_only_when_present(self):
        payload = {'hook_event_name': 'PostToolUse', 'tool_name': 'TodoWrite', 'tool_use_id': 't',
                   'tool_input': {'todos': [{'content': 'a', 'status': 'completed'}]}, 'tool_response': {}}
        data = self.build(payload)[1]
        self.assertEqual((data['todos'], data['todo_mode']), ([{'id': None, 'subject': 'a', 'status': 'completed'}], 'replace'))
        self.assertNotIn('todos', self.build(fixture('PostToolUse-Bash'))[1])

    def test_ids_and_names_are_bounded(self):
        payload = {**fixture('PreToolUse-Bash'), 'tool_use_id': 7, 'agent_id': 'x' * 200, 'agent_type': 'T' * 100,
                   'tool_name': 'mcp__' + 'n' * 200}
        data = self.build(payload)[1]
        self.assertEqual((data['tool_use_id'], data['agent_id']), (None, None))
        self.assertEqual(utf16_len(data['agent_type']), 64)
        self.assertEqual(utf16_len(data['tool']), steps.TOOL_NAME_MAX)

    def test_ignored_payloads(self):
        self.assertIsNone(self.build({**fixture('PreToolUse-Bash'), 'tool_name': 'AskUserQuestion'}))
        self.assertIsNone(self.build({**fixture('PreToolUse-Bash'), 'tool_name': ''}))
        self.assertIsNone(self.build({'hook_event_name': 'Elicitation'}))
        self.assertIsNone(self.build(fixture('Stop')))

    def test_non_mapping_input_never_raises(self):
        for bad in (None, 'text', [1], 3.5):
            for name in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure'):
                payload = {'hook_event_name': name, 'tool_name': 'Edit', 'tool_input': bad, 'tool_response': bad}
                self.assertIsNotNone(self.build(payload))

    def test_huge_write_never_copies_content(self):
        content = ''.join(f'line {i}: some file content that must stay on the server\n' for i in range(100_000))
        content = (content * 2)[:5 * 1024 * 1024]
        payload = {**fixture('PostToolUse-Write'), 'tool_input': {'file_path': '<cwd>/big.txt', 'content': content}}
        payload['tool_response'] = {**payload['tool_response'], 'content': content}
        line = json.dumps(self.build(payload), ensure_ascii=False)
        self.assertLess(len(line.encode('utf-8')), 2000)
        self.assertNotIn(content[1000:1040], line)
        self.assertNotIn('must stay on the server', line)


if __name__ == '__main__':
    unittest.main()
