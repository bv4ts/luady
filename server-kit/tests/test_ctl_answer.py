"""luady-ctl answer / permission / pending against live and dead waiting hooks."""
from __future__ import annotations

import io
import json
import os
import subprocess
import threading
import unittest

from luady_kit import common, hook
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase, wait_until
from tests.test_hook_wait import ASK, PERMISSION, fake_tmux


class CtlAnswerTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.write_config(host_alias='cedar', hook_wait_seconds=10)
        self.mark_hub_listening()
        self.ctx = make_ctx(self.home)

    def start_hook(self, payload):
        """Run the real hook in a thread until it waits; returns (thread, result, qid)."""
        result = {}
        env = hook.HookEnv(paths=self.paths, tmux=fake_tmux(), environ={'TMUX_PANE': '%1'}, poll_interval=0.02)

        def target():
            out = io.BytesIO()
            hook.main(stdin=io.BytesIO(json.dumps(payload).encode('utf-8')), stdout=out, env=env)
            result['output'] = json.loads(out.getvalue()) if out.getvalue() else None

        thread = threading.Thread(target=target)
        thread.start()
        wait_until(lambda: list(self.paths.pending.glob('*.json')))
        return thread, result, next(self.paths.pending.glob('*.json')).stem

    def manual_pending(self, qid, kind, pid=None, start=None):
        own = os.getpid()
        payload = ({'questions': hook.valid_questions(ASK['tool_input'])} if kind == 'question'
                   else {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}})
        common.atomic_write_json(common.pending_path(self.paths, qid), {
            'qid': qid, 'kind': kind, 'created_at': '2026-10-09T10:00:00.000Z', 'session_id': 'sess-1',
            'tmux': 'cc-app:0.0', 'payload': payload, 'meta': {'session_id': 'sess-1', 'tmux': 'cc-app:0.0'},
            'pid': own if pid is None else pid, 'pid_start': common.proc_start_ticks(own) if start is None else start})

    def test_answer_round_trip_with_hook(self):
        thread, result, qid = self.start_hook(ASK)
        code, out = run_ctl(self.ctx, 'pending')
        [item] = out['pending']
        self.assertEqual({key: item[key] for key in ('qid', 'kind', 'session_id', 'tmux')},
                         {'qid': qid, 'kind': 'question', 'session_id': 'sess-1', 'tmux': 'cc-app:0.0'})
        body = json.dumps({'answers': {'Which color?': 'Blue'}}).encode('utf-8')
        self.assertEqual(run_ctl(self.ctx, 'answer', '--qid', qid, stdin=body), (0, {'ok': True}))
        thread.join(10)
        self.assertEqual(result['output']['hookSpecificOutput']['updatedInput']['answers'], {'Which color?': 'Blue'})
        self.assertEqual(run_ctl(self.ctx, 'pending'), (0, {'pending': []}))

    def test_the_hub_answers_the_redacted_copy_and_claude_gets_the_originals(self):
        token = 'ghp_' + 'Q7x' * 12
        questions = [
            {'question': f'Push with {token}?', 'options': [{'label': f'Yes, use {token}'}, {'label': 'No'}]},
            {'question': 'Which ones?', 'multiSelect': True,
             'options': [{'label': f'key {token}', 'description': f'the {token} one'}, {'label': 'Plain'}]},
        ]
        thread, result, qid = self.start_hook({**ASK, 'tool_input': {'questions': questions}})
        [event] = [e for e in self.spool_events() if e['event'] == 'question']
        self.assertNotIn(token, json.dumps(event))
        shown = event['data']['questions']
        self.assertEqual((shown[0]['question'], shown[1]['options'][0]['description']), ('Push with [redacted]?', 'the [redacted] one'))
        answers = {shown[0]['question']: shown[0]['options'][0]['label'],
                   shown[1]['question']: f"{shown[1]['options'][0]['label']}, Plain"}
        body = json.dumps({'answers': answers}).encode('utf-8')
        self.assertEqual(run_ctl(self.ctx, 'answer', '--qid', qid, stdin=body), (0, {'ok': True}))
        thread.join(10)
        self.assertEqual(result['output']['hookSpecificOutput']['updatedInput']['answers'],
                         {f'Push with {token}?': f'Yes, use {token}', 'Which ones?': f'key {token}, Plain'})

    def test_original_answers_leaves_what_it_cannot_map(self):
        questions = [{'question': 'a [1]', 'options': []}, {'question': 'a [2]', 'options': []}]
        shown = [{'question': 'a [x]', 'options': []}, {'question': 'a [x]', 'options': []}]
        body = {'answers': {'a [x]': 'free text'}}
        self.assertEqual(hook.original_answers(body, questions, shown), body)
        self.assertEqual(hook.original_answers(body, questions, None), body)
        self.assertEqual(hook.original_answers({'release': True}, questions, shown), {'release': True})

    def test_permission_round_trip_and_kind_check(self):
        thread, result, qid = self.start_hook(PERMISSION)
        code, out = run_ctl(self.ctx, 'answer', '--qid', qid, stdin=b'{"release": true}')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        body = {'behavior': 'deny', 'message': 'Use npm ci instead'}
        self.assertEqual(run_ctl(self.ctx, 'permission', '--qid', qid, stdin=json.dumps(body).encode('utf-8')),
                         (0, {'ok': True}))
        thread.join(10)
        self.assertEqual(result['output']['hookSpecificOutput']['decision'], body)

    def test_second_answer_is_refused_while_first_is_unread(self):
        self.manual_pending('AAAAAAAA', 'question')
        body = json.dumps({'answers': {'Which color?': 'Red'}}).encode('utf-8')
        self.assertEqual(run_ctl(self.ctx, 'answer', '--qid', 'AAAAAAAA', stdin=body), (0, {'ok': True}))
        code, out = run_ctl(self.ctx, 'answer', '--qid', 'AAAAAAAA', stdin=b'{"release": true}')
        self.assertEqual((code, out['error']['code']), (3, 'refused'))
        self.assertEqual(json.loads(common.answer_path(self.paths, 'AAAAAAAA').read_text(encoding='utf-8')),
                         {'answers': {'Which color?': 'Red'}})

    def test_answer_and_permission_validation(self):
        self.manual_pending('BBBBBBBB', 'question')
        for body in (b'not json', b'{}', b'{"answers": {}}', b'{"answers": {"Nope?": "Red"}}',
                     b'{"answers": {"Which color?": 5}}', b'{"release": false}', b'{"release": true, "extra": 1}'):
            code, out = run_ctl(self.ctx, 'answer', '--qid', 'BBBBBBBB', stdin=body)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), body)
        self.manual_pending('CCCCCCCC', 'permission')
        for body in (b'{"behavior": "maybe"}', b'{"behavior": "deny", "message": 3}', b'{"message": "x"}'):
            code, out = run_ctl(self.ctx, 'permission', '--qid', 'CCCCCCCC', stdin=body)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), body)
        code, out = run_ctl(self.ctx, 'permission', '--qid', 'BBBBBBBB', stdin=b'{"behavior": "allow"}')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))

    def test_unknown_qid_is_not_found(self):
        code, out = run_ctl(self.ctx, 'answer', '--qid', 'ZZZZZZZZ', stdin=b'{"release": true}')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))

    def test_dead_waiter_is_reaped_once(self):
        dead = subprocess.Popen(['true'])
        dead.wait()
        self.manual_pending('DDDDDDDD', 'question', pid=dead.pid, start=1)
        code, out = run_ctl(self.ctx, 'answer', '--qid', 'DDDDDDDD', stdin=b'{"release": true}')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        self.assertEqual(run_ctl(self.ctx, 'pending'), (0, {'pending': []}))
        resolved = [e for e in self.spool_events() if e['event'] == 'question_resolved']
        self.assertEqual([(e['data']['qid'], e['data']['outcome']) for e in resolved], [('DDDDDDDD', 'error')])
        self.assertFalse(common.pending_path(self.paths, 'DDDDDDDD').exists())


if __name__ == '__main__':
    unittest.main()
