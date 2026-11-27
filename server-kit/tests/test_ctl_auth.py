"""auth-status, auth-login and auth-code verbs (/login from the chat) against a fake tmux + claude."""
from __future__ import annotations

import json
import unittest

from luady_kit import auth
from luady_kit.common import RunResult
from tests.ctl_helpers import make_ctx, run_ctl
from tests.helpers import HomeTestCase

URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&code_challenge=x_Y-z&state=s1'
GOOD = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
BAD = 'wrongcode123456#wrong-state-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
PROMPT = 'Paste code here if prompted > '
NO_ACCOUNT = {'org_id': None, 'org_name': None, 'plan': None, 'plan_tier': None}


class FakeHost:
    """tmux on socket luady-auth plus `claude auth status`, as one state machine."""

    def __init__(self, show_url: bool = True, logged_in: bool = False, echo: bool = False) -> None:
        self.show_url = show_url
        self.echo = echo
        self.logged_in = logged_in
        self.account: dict = {}
        self.stay_signed_in = False
        self.session = False
        self.screen = ''
        self.typed = ''
        self.calls: list[list[str]] = []

    def ok(self, text: str = '') -> RunResult:
        return RunResult(0, text.encode(), b'')

    def run(self, argv, input_bytes=None, timeout=10.0, cwd=None) -> RunResult:
        self.calls.append(list(argv))
        if argv[:3] == ['tmux', '-L', auth.SOCKET]:
            return self.tmux(argv[3:])
        if argv[1:] == ['auth', 'status']:
            expires = '2026-12-06T23:26:48.783Z' if self.logged_in else None
            body = {'loggedIn': self.logged_in, 'authMethod': 'claude.ai' if self.logged_in else 'none',
                    'email': 'owner@example.com' if self.logged_in else None, 'loginExpiresAt': expires,
                    **(self.account if self.logged_in else {})}
            return RunResult(0 if self.logged_in else 1, json.dumps(body).encode(), b'')
        if argv[1:] == ['auth', 'logout']:
            if self.stay_signed_in:
                return RunResult(1, b'Logging out...\n', b'Error: could not remove the stored credentials\n\n')
            self.logged_in = False
            return RunResult(0, b'Successfully logged out from your Anthropic account.\n', b'')
        raise AssertionError(f'unexpected command {argv}')

    def tmux(self, args: list[str]) -> RunResult:
        verb = args[0]
        if verb == 'kill-server':
            self.session = False
            return self.ok()
        if verb == 'new-session':
            self.session = True
            self.screen = 'Opening browser to sign in…\n'
            if self.show_url:
                self.screen += f"If the browser didn't open, visit: {URL}\n{PROMPT}"
            else:
                self.screen += 'Error: something broke\n[luady-auth exit 1]\n'
            return self.ok()
        if verb == 'has-session':
            return self.ok() if self.session else RunResult(1, b'', b'no server')
        if verb == 'capture-pane':
            return self.ok(self.screen) if self.session else RunResult(1, b'', b'no server')
        if verb == 'send-keys' and '-l' in args:
            self.typed = args[-1]
            if self.echo:
                self.screen += self.typed
            return self.ok()
        if verb == 'send-keys' and args[-1] == 'Enter':
            if self.typed == GOOD:
                self.logged_in = True
                self.screen += '\nLogin successful.\n[luady-auth exit 0]\n'
            elif self.typed == 'retrycode12345678':
                self.screen += f'\nInvalid code, try again\n{PROMPT}'
            else:
                self.screen += '\nOAuth error: Invalid code\n[luady-auth exit 1]\n'
            return self.ok()
        raise AssertionError(f'unexpected tmux {args}')


class CtlAuthTest(HomeTestCase):
    def setUp(self):
        super().setUp()
        self.paths.claude_bin.parent.mkdir(parents=True, exist_ok=True)
        self.paths.claude_bin.write_text('#!/bin/sh\n', encoding='ascii')
        self.host = FakeHost()

    def ctx(self):
        return make_ctx(self.home, run=self.host.run, sleep=lambda s: None)

    def test_status_signed_out_and_in(self):
        self.assertEqual(run_ctl(self.ctx(), 'auth-status'),
                         (0, {'logged_in': False, 'email': None, 'expires_at': None, **NO_ACCOUNT, 'auth_method': 'none'}))
        self.host.logged_in = True
        self.assertEqual(run_ctl(self.ctx(), 'auth-status')[1],
                         {'logged_in': True, 'email': 'owner@example.com', 'expires_at': '2026-12-06T23:26:48.783Z',
                          **NO_ACCOUNT, 'auth_method': 'claude.ai'})

    def test_status_reports_the_account_behind_the_sign_in(self):
        self.host.logged_in = True
        self.host.account = {'orgId': 'org_123', 'orgName': 'Acme', 'subscriptionType': 'team', 'planTier': 'standard',
                             'configDirectory': '/home/dev/.claude', 'email': None}
        out = run_ctl(self.ctx(), 'auth-status')[1]
        self.assertEqual({key: out[key] for key in ('email', 'org_id', 'org_name', 'plan', 'plan_tier', 'auth_method')},
                         {'email': None, 'org_id': 'org_123', 'org_name': 'Acme', 'plan': 'team', 'plan_tier': 'standard',
                          'auth_method': 'claude.ai'})
        self.host.account = {'orgId': 7, 'subscriptionType': ['max']}
        out = run_ctl(self.ctx(), 'auth-status')[1]
        self.assertEqual((out['org_id'], out['plan']), (None, None))

    def test_logout_signs_out_and_stops_a_waiting_sign_in(self):
        self.host.logged_in = True
        run_ctl(self.ctx(), 'auth-login')
        code, out = run_ctl(self.ctx(), 'auth-logout')
        self.assertEqual(code, 0)
        self.assertEqual((out['ok'], out['logged_in'], out['message']), (True, False, 'Signed out'))
        self.assertEqual(sum(1 for call in self.host.calls if call[1:] == ['auth', 'logout']), 1)
        self.assertFalse(self.host.session)
        self.assertEqual(set(out), {'ok', 'message', 'logged_in', 'email', 'expires_at', *NO_ACCOUNT, 'auth_method'})

    def test_logout_that_does_not_sign_out_reports_what_claude_said(self):
        self.host.logged_in = True
        self.host.stay_signed_in = True
        code, out = run_ctl(self.ctx(), 'auth-logout')
        self.assertEqual((code, out['ok'], out['logged_in']), (0, False, True))
        self.assertEqual(out['message'], 'Error: could not remove the stored credentials')

    def test_logout_without_claude(self):
        self.paths.claude_bin.unlink()
        code, out = run_ctl(self.ctx(), 'auth-logout')
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))
        self.assertEqual(self.host.calls, [])

    def test_status_without_claude(self):
        self.paths.claude_bin.unlink()
        self.assertEqual(run_ctl(self.ctx(), 'auth-status')[0], 4)

    def test_status_non_json_fails(self):
        ctx = make_ctx(self.home, run=lambda argv, **kw: RunResult(1, b'boom', b''))
        code, out = run_ctl(ctx, 'auth-status')
        self.assertEqual((code, out['error']['code']), (1, 'failed'))

    def test_login_returns_link_on_its_own_socket(self):
        code, out = run_ctl(self.ctx(), 'auth-login')
        self.assertEqual((code, out), (0, {'url': URL}))
        new_session = next(c for c in self.host.calls if 'new-session' in c)
        self.assertEqual(new_session[:3], ['tmux', '-L', 'luady-auth'])
        self.assertIn('auth login --claudeai', new_session[-1])
        self.assertTrue(new_session[-1].startswith('timeout --foreground 1800 '))

    def test_login_without_link_times_out_and_cleans_up(self):
        self.host.show_url = False
        code, out = run_ctl(self.ctx(), 'auth-login')
        self.assertEqual((code, out['error']['code']), (5, 'timeout'))
        self.assertIn('something broke', out['error']['message'])
        self.assertFalse(self.host.session)

    def test_good_code_signs_in(self):
        run_ctl(self.ctx(), 'auth-login')
        code, out = run_ctl(self.ctx(), 'auth-code', stdin=f'  {GOOD}\n'.encode())
        self.assertEqual(code, 0)
        self.assertEqual((out['ok'], out['logged_in'], out['expires_at']), (True, True, '2026-12-06T23:26:48.783Z'))
        self.assertFalse(self.host.session)

    def test_good_code_signs_in_when_claude_echoes_it(self):
        self.host.echo = True
        run_ctl(self.ctx(), 'auth-login')
        code, out = run_ctl(self.ctx(), 'auth-code', stdin=GOOD.encode())
        self.assertEqual((code, out['ok']), (0, True))

    def test_rejected_code_that_prompts_again_keeps_waiting(self):
        run_ctl(self.ctx(), 'auth-login')
        code, out = run_ctl(self.ctx(), 'auth-code', stdin=b'retrycode12345678')
        self.assertEqual((code, out['ok']), (0, False))
        self.assertIn('Invalid code, try again', out['message'])
        self.assertTrue(self.host.session)
        code, out = run_ctl(self.ctx(), 'auth-code', stdin=GOOD.encode())
        self.assertEqual((code, out['ok']), (0, True))

    def test_bad_code_reports_what_claude_said(self):
        run_ctl(self.ctx(), 'auth-login')
        code, out = run_ctl(self.ctx(), 'auth-code', stdin=BAD.encode())
        self.assertEqual((code, out['ok'], out['logged_in']), (0, False, False))
        self.assertIn('Invalid code', out['message'])
        self.assertFalse(out['message'].startswith('if prompted'))
        self.assertNotIn(BAD, out['message'])

    def test_code_without_waiting_login(self):
        code, out = run_ctl(self.ctx(), 'auth-code', stdin=GOOD.encode())
        self.assertEqual((code, out['error']['code']), (4, 'not_found'))

    def test_code_after_login_ended(self):
        run_ctl(self.ctx(), 'auth-login')
        self.host.screen += '\n[luady-auth exit 124]\n'
        self.assertEqual(run_ctl(self.ctx(), 'auth-code', stdin=GOOD.encode())[1]['error']['code'], 'not_found')

    def test_code_must_look_like_a_code(self):
        run_ctl(self.ctx(), 'auth-login')
        for junk in (b'', b'hello world', b'abc; rm -rf /', b'x' * 3000):
            code, out = run_ctl(self.ctx(), 'auth-code', stdin=junk)
            self.assertEqual((code, out['error']['code']), (2, 'usage'), junk[:20])

    def test_login_script_quotes_the_binary(self):
        script = auth.login_script("/home/a b/claude")
        self.assertIn("'/home/a b/claude' auth login --claudeai", script)
        self.assertIn('sleep 600', script)


if __name__ == '__main__':
    unittest.main()
