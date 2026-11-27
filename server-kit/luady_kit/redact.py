"""Secret redaction and short clips for everything the kit sends off the server (kit 2).

- `redact()` replaces credentials in commands, URLs, headers, config text and file contents by `[redacted]`.
  The rules run in a fixed order (see RULES); each is a precompiled pattern with bounded or linear matching,
  so two megabytes take under two seconds (a test checks it). It is best effort: it knows common secret shapes, not
  every secret.
- A redaction replaces only the secret. An unquoted value never consumes a shell separator, a redirection or a
  substitution, or what follows them, so a dangerous tail (`; rm -rf ~`, `| sh`) stays visible, and the literal
  `[redacted]` tells the hub the text was changed. A quoted value runs to its closing quote but never holds `$(` or a
  backtick. A pattern cannot follow shell quoting in general (a quote that closes an earlier string, `eval` or `ssh`
  reading a quoted value again), so the kit never offers Allow for a command whose preview was redacted (preview.py).
- `clip()` and `cut_utf16()` cut by UTF-16 code units, the unit the hub's limits are counted in.

Standard library only.
"""
from __future__ import annotations

import re
import sys
from typing import Any, Callable

REDACTED = '[redacted]'
# A possessive `+` after a bounded run stops the engine from giving characters back (it never helps these rules: what
# follows the run is a character the run cannot hold), which saves time on hostile text. Python accepts it from 3.11;
# on 3.10, which the kit supports, the run is plain greedy: the same matches, a little slower.
_KEEP = '+' if sys.version_info >= (3, 11) else ''
ELLIPSIS = '…'

_KEYWORD = r'(?:api[_-]?key|token|secret|passphrase|passwd|password|pwd|credential|auth)'
# A name that ends in _pass / _key (DB_PASS=, STRIPE_KEY=, --user_pass=) also holds a secret.
_NAME = r'(?:' + _KEYWORD + r'[\w-]{0,64}' + _KEEP + r'|[_-](?:pass|key)\b)'
_SCHEME = r'(?:bearer|basic|token|digest)'
_ALREADY = r'(?!\[redacted\])(?![A-Za-z][\w.-]{0,30}[ \t]+\[redacted\])'  # keeps every rule idempotent
# An unquoted value never consumes a shell separator or anything after it (; | & && || newline ) ` $( ): the rest of
# the command must stay visible to the owner and to the hub's risk check, and is itself scanned. These fragments are
# one character that is none of them (and no whitespace); _BARE also stops at quotes. A quoted value runs to its
# closing quote: inside quotes the separators are part of the secret. A value holding `$(` or a backtick is not taken
# as quoted (in double quotes they run; single quotes nested in double quotes, or read again by `eval`, run them too).
_NO_SUBST = r'(?!\$\()'
_SAFE = _NO_SUBST + r'[^\s;|&)`<>]'  # a redirection is never swallowed either
_BARE = _NO_SUBST + r'[^\s"\';|&)`<>]'
_IN_DOUBLE = _NO_SUBST + r'[^"\n`]'
_IN_SINGLE = _NO_SUBST + r'[^\'\n`]'
_QUOTED = r'"(?:' + _IN_DOUBLE + r')*"|\'(?:' + _IN_SINGLE + r')*\''
# A word that starts like a path or a URL is never redacted as a whole (a URL's password still is).
_NOT_A_PATH = r'(?!["\']?(?:/|\./|\.\./|~|[A-Za-z][A-Za-z0-9+.-]*://))'
_VALUE = r'(?:' + _NOT_A_PATH + r'(?:' + _QUOTED + r'|["\']?(?:' + _BARE + r')+))'
_PEM_LABEL = r'[A-Z0-9 ]{0,40}PRIVATE KEY-----'
_PEM_LINE = r'(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{16,}={0,2}[ \t]*(?=\r?\n|$)'
# One line of a key body: base64 holding a capital or a digit (a lower-case word such as `reboot`, or a path such as
# /sbin/reboot, is a command, never key text), or one of the two header lines of an old encrypted key. Never a space
# between words, so no command with arguments.
_PEM_BODY_LINE = (r'(?:(?=[A-Za-z0-9+/]*[A-Z0-9])[A-Za-z0-9+/]{1,1024}={0,2}'
                  r'|(?:Proc-Type|DEK-Info):[ \t]?[A-Za-z0-9,-]{1,80})')

# 1. A private key block, as one redaction: BEGIN … END with only key lines between them, or, with no END (or with
#    anything else between them), the rest of the BEGIN line and the base64 lines after it. A separator or anything
#    else after the block stays.
_PRIVATE_KEY = re.compile(
    r'-----BEGIN' + _PEM_LABEL + r'(?:(?:[ \t]*\r?\n[ \t]*(?:' + _PEM_BODY_LINE + r')?){0,512}?[ \t]*\r?\n[ \t]*-----END'
    + _PEM_LABEL + r'|(?:[ \t]*[A-Za-z0-9+/=]+)*(?:\r?\n' + _PEM_LINE + r')*)')
# 2. user:password@ in a URL (a password may not hold '/' or '@' unencoded): the password goes, the user stays.
#    A password holding a shell separator, a bracket, a redirection, `$` or a backtick is left whole: it cannot be
#    told from a command hidden in the URL (ftp://u:x;rm${IFS}-rf${IFS}~;echo${IFS}@h).
_URL_CREDENTIALS = re.compile(r'(://(?:' + _NO_SUBST + r'[^\s/@:;|&)`]){0,256}:)[^\s/@;|&()<>$`]{1,256}(@)')
# 2b. user:password as an argument (curl/wget -u, --user, --proxy-user): the password goes, the user stays.
#     A URL value (`-u redis://…`) is left to rule 2; a numeric uid:gid (`docker run -u 1000:1000`) is not a secret.
_USER = r'(?:' + _NO_SUBST + r'[^\s"\';|&)`:/])+'
_USER_PASSWORD = re.compile(
    r'(?<!\S)((?:--user|--proxy-user)(?:=|[ \t]+)|-[uU][ \t]*)'
    r'(?:(")(' + _USER + r'):(?!//)(?!\[redacted\])(?:' + _IN_DOUBLE + r')+(?=")'
    r'|(\')(' + _USER + r'):(?!//)(?!\[redacted\])(?:' + _IN_SINGLE + r')+(?=\')'
    r'|()(' + _USER + r'):(?!//)((?:' + _BARE + r')+))')
# 2c. Authorization / Proxy-Authorization header values: any scheme word stays (ApiKey, Token, Negotiate…), the
#     credential goes; a value without a scheme goes whole.
_AUTH_HEADER = re.compile(
    r'(?i)\b((?:proxy-)?authorization[ \t]*:[ \t]*)(?:([A-Za-z][\w.-]{0,30})([ \t]+)(?!\[redacted\])(?:' + _BARE
    + r')+|' + _ALREADY + r'(?:' + _BARE + r')+)')
# 2d. Cookie / Set-Cookie header values. Inside quotes ("Cookie: a=1; b=2") the value runs to the closing quote (the
#     cookies are separated by ';'); outside quotes it ends like any bare value, at whitespace, ; & | ) < > and quotes.
_COOKIE_NAME = r'((?:set-)?cookie[ \t]*:[ \t]*)(?!\[redacted\])'
_COOKIE = re.compile(
    r'(?i)(?:(")' + _COOKIE_NAME + r'(?:' + _IN_DOUBLE + r')+(?=")'
    r'|(\')' + _COOKIE_NAME + r'(?:' + _IN_SINGLE + r')+(?=\')'
    r'|\b' + _COOKIE_NAME + r'(?:' + _BARE + r')+)')
# 3. Bearer and Basic credentials, only after a header name ("templates/basic /var/www" is no header).
_AUTH_SCHEME = re.compile(
    r'(?i)((?<![\w-])[A-Za-z][\w-]{0,64}' + _KEEP + r'[ \t]*:[ \t]*)(bearer|basic)[ \t]+([A-Za-z0-9._~+/=-]{8,})')
# 3b. openssl -passin pass:X / -passout pass:X (env:, file: and fd: forms name no secret).
_OPENSSL_PASS = re.compile(r'(-pass(?:in|out)[ \t]+pass:)' + _ALREADY + _VALUE)
# 4a. name = value / name: value / name => value, the name holding a secret-ish word (also a JSON or PHP key:
#     "password": "…", 'password' => '…').
_NAMED_VALUE = re.compile(
    r'(?i)(' + _NAME + r'["\']?[ \t]*(?:=>|[:=])[ \t]*)' + _ALREADY
    + r'(?:(' + _SCHEME + r')[ \t]+(?:' + _BARE + r')+|' + _VALUE + r')')
# 4b. A long option with a secret-ish name and its value after a space: --password hunter2.
_NAMED_OPTION = re.compile(
    r'(?i)(--[\w-]{0,64}?' + _KEYWORD + r'[\w-]{0,64}' + _KEEP + r'[ \t]+)(?!-)' + _VALUE)
# 5. A password after -p (sshpass -p SECRET, mysql -pSECRET), unless the command uses -p for something else
#    (P_NOT_PASSWORD) or the value is a plain number or a path; find/gcc options that start with -p are not passwords.
_SHORT_PASSWORD = re.compile(
    r'(?<=\s)-p(?:[ \t]+(?!-)(' + _VALUE + r')'
    r'|(?!(?:rint0?|rintf|rune|ath|erm|thread|edantic|ipe|ass(?:in|out))\b)((?:' + _SAFE + r'){4,}))')
P_NOT_PASSWORD = frozenset({'mkdir', 'cp', 'ssh', 'scp', 'rsync', 'tar', 'npm', 'node', 'python', 'python3', 'git',
                            'docker', 'nc', 'lsof', 'read'})  # `docker login -p` is a password and stays redacted
_WRAPPERS = frozenset({'sudo', 'env', 'nohup', 'time', 'exec', 'command', 'nice', 'stdbuf', 'xargs'})
_ASSIGNMENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*=\S*')
_PATH_OR_NUMBER = re.compile(r'[0-9]+|[.~]{1,2}|(?:/|\./|\.\./|~/)\S*')
_COMMAND_START = re.compile(r'[;|&\n(`]')
COMMAND_LOOKBACK = 1024
# 5b. redis-cli -a PASSWORD (other commands use -a for "all").
_REDIS_PASS = re.compile(r'(?<=\s)-a[ \t]+(?!-)(' + _VALUE + r')')
A_IS_PASSWORD = frozenset({'redis-cli'})
# 6. Token shapes of well-known services (two prefixes are split in two so secret scanners pass this file).
_TOKEN_SHAPES = re.compile(
    r'(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github' r'_pat_[A-Za-z0-9_]{20,}'
    r'|gl' r'pat-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}'
    r'|xox[abprs]-[A-Za-z0-9-]{10,}|A(?:KIA|SIA)[0-9A-Z]{16}'
    r'|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})')
# 7. Long random strings (no '/', so paths survive) and runs of 32 or more hexadecimal digits.
_LONG_RUN = re.compile(r'(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}')
_LONG_HEX = re.compile(r'(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])')
_DIGIT = re.compile(r'[0-9]')
_LOWER = re.compile(r'[a-z]')
_UPPER = re.compile(r'[A-Z]')
_WHITESPACE = re.compile(r'\s+')


def _auth_scheme(match: re.Match[str]) -> str:
    credential = match.group(3)
    if credential.isalpha() and credential.islower():  # an English word ("basic validation"), not a credential
        return match.group(0)
    return f'{match.group(1)}{match.group(2)} {REDACTED}'


def _auth_header(match: re.Match[str]) -> str:
    scheme = match.group(2)
    return match.group(1) + (f'{scheme}{match.group(3)}{REDACTED}' if scheme else REDACTED)


def _redis_pass(match: re.Match[str]) -> str:
    command, _ = _commands_before(match.string, match.start())
    if command not in A_IS_PASSWORD:
        return match.group(0)
    return match.group(0)[:len(match.group(0)) - len(match.group(1))] + REDACTED


def _cookie(match: re.Match[str]) -> str:
    quote = match.group(1) or match.group(3) or ''
    return quote + (match.group(2) or match.group(4) or match.group(5)) + REDACTED


def _named_value(match: re.Match[str]) -> str:
    scheme = match.group(2)
    return match.group(1) + (f'{scheme} {REDACTED}' if scheme else REDACTED)


def _url_credentials(match: re.Match[str]) -> str:
    return f'{match.group(1)}{REDACTED}{match.group(2)}'


def _user_password(match: re.Match[str]) -> str:
    quote, user = next((match.group(i), match.group(i + 1)) for i in (2, 4, 6) if match.group(i + 1) is not None)
    if not quote and user.isdigit() and match.group(8).isdigit():
        return match.group(0)  # uid:gid
    return f'{match.group(1)}{quote}{user}:{REDACTED}'


def _commands_before(text: str, end: int) -> tuple[str | None, set[str]]:
    """(the command of the simple command that `end` lies in, the commands quoted inside it, as for `sh -c "…"`)."""
    start = max(0, end - COMMAND_LOOKBACK)
    segment = text[start:end]
    cut = max((found.end() for found in _COMMAND_START.finditer(segment)), default=0)
    words = segment[cut:].split()
    quoted = {word.strip('"\'').rsplit('/', 1)[-1] for word in words if word[:1] in '"\''}
    index = 0
    while index < len(words) and (words[index] in _WRAPPERS or _ASSIGNMENT.fullmatch(words[index])
                                  or (index and words[index].startswith('-'))):
        index += 2 if words[index] in ('-u', '-g') and index and words[index - 1] == 'sudo' else 1
    first = words[index].strip('"\'').rsplit('/', 1)[-1] if index < len(words) else None
    if first == 'docker' and 'login' in words[index + 1:index + 3]:
        return 'docker login', quoted
    return first, quoted


def _short_password(match: re.Match[str]) -> str:
    value = match.group(1) if match.group(1) is not None else match.group(2)
    command, quoted = _commands_before(match.string, match.start())
    if _PATH_OR_NUMBER.fullmatch(value.strip('"\'')) or command in P_NOT_PASSWORD or quoted & P_NOT_PASSWORD:
        return match.group(0)
    return match.group(0)[:len(match.group(0)) - len(value)] + REDACTED


def _long_run(match: re.Match[str]) -> str:
    run = match.group(0)
    mixed = _DIGIT.search(run) and _LOWER.search(run) and _UPPER.search(run)
    return REDACTED if mixed else run


RULES: tuple[tuple[re.Pattern[str], str | Callable[[re.Match[str]], str]], ...] = (
    (_PRIVATE_KEY, REDACTED),
    (_URL_CREDENTIALS, _url_credentials),
    (_USER_PASSWORD, _user_password),
    (_AUTH_HEADER, _auth_header),
    (_COOKIE, _cookie),
    (_AUTH_SCHEME, _auth_scheme),
    (_OPENSSL_PASS, lambda match: match.group(1) + REDACTED),
    (_NAMED_VALUE, _named_value),
    (_NAMED_OPTION, lambda match: match.group(1) + REDACTED),
    (_SHORT_PASSWORD, _short_password),
    (_REDIS_PASS, _redis_pass),
    (_TOKEN_SHAPES, REDACTED),
    (_LONG_RUN, _long_run),
    (_LONG_HEX, REDACTED),
)


# Prose (a prompt, Claude's message, a notification, a question) is read by people to know what a session did, so
# three rules are narrower there; commands and previews keep the strict ones above:
# - a name counts only when its secret word ends it (`password:`, `GITHUB_TOKEN=`; not `Author:`, `tokens:`), `==` is
#   a comparison, not an assignment, and the value must look like a secret: quoted, or 6 characters with a digit;
# - an Authorization header's value must look like a secret too ("Authorization: checked per route");
# - a hex run right after `commit `, `sha1:`, `sha256:`, `sha512:`, `@` or `#` is a hash, not a key.
_PROSE_NAME = r'(?<![\w-])[\w-]{0,64}?(?:' + _KEYWORD + r'|[_-](?:pass|key))(?![\w-])'
_NAMED_VALUE_PROSE = re.compile(
    r'(?i)(' + _PROSE_NAME + r'["\']?[ \t]*(?:=>|:|(?<![=!<>])=(?!=))[ \t]*)' + _ALREADY
    + r'(?:(' + _SCHEME + r')[ \t]+((?:' + _BARE + r')+)|(' + _VALUE + r'))')
_AUTH_HEADER_PROSE = re.compile(
    r'(?i)\b((?:proxy-)?authorization[ \t]*:[ \t]*)(?:([A-Za-z][\w.-]{0,30})([ \t]+)(?!\[redacted\])((?:' + _BARE
    + r')+)|' + _ALREADY + r'((?:' + _BARE + r')+))')
_LONG_HEX_PROSE = re.compile(
    r'(?<![0-9A-Fa-f])(?<!ommit )(?<!sha1:)(?<!sha256:)(?<!SHA256:)(?<!sha512:)(?<![@#])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])')


def _secret_looking(value: str) -> bool:
    if value[:1] in ('"', "'"):
        return True
    return len(value) >= 6 and _DIGIT.search(value) is not None


def _named_value_prose(match: re.Match[str]) -> str:
    scheme, value = match.group(2), match.group(3) or match.group(4)
    if not _secret_looking(value):
        return match.group(0)
    return match.group(1) + (f'{scheme} {REDACTED}' if scheme else REDACTED)


def _auth_header_prose(match: re.Match[str]) -> str:
    scheme, value = match.group(2), match.group(4) or match.group(5)
    if not _secret_looking(value):
        return match.group(0)
    return match.group(1) + (f'{scheme}{match.group(3)}{REDACTED}' if scheme else REDACTED)


_IN_PROSE = {_NAMED_VALUE: (_NAMED_VALUE_PROSE, _named_value_prose), _AUTH_HEADER: (_AUTH_HEADER_PROSE, _auth_header_prose),
             _LONG_HEX: (_LONG_HEX_PROSE, REDACTED)}
PROSE_RULES = tuple(_IN_PROSE.get(pattern, (pattern, replacement)) for pattern, replacement in RULES)


def redact(text: str, prose: bool = False) -> str:
    """Text with every secret the rules recognise replaced by [redacted]; unchanged when nothing matches. `prose`
    uses the narrower PROSE_RULES (for what people read, never for a command or a preview).

    Never raises: a non-string gives '' and an internal failure gives [redacted] (nothing unchecked leaves).
    """
    if not isinstance(text, str):
        return ''
    try:
        for pattern, replacement in PROSE_RULES if prose else RULES:
            text = pattern.sub(replacement, text)
    except Exception:  # noqa: BLE001 - the caller must get a safe string whatever happens
        return REDACTED
    return text


def redact_values(value: Any, prose: bool = False) -> Any:
    """A copy of a JSON value with every string redacted (keys are kept as they are)."""
    if isinstance(value, str):
        return redact(value, prose)
    if isinstance(value, dict):
        return {key: redact_values(item, prose) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_values(item, prose) for item in value]
    return value


def utf16_len(text: str) -> int:
    """Length in UTF-16 code units (what JavaScript's String.length and the hub's limits count)."""
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def cut_utf16(text: str, limit: int) -> tuple[str, bool]:
    """Cut text to at most `limit` UTF-16 code units, ending with … when cut. Returns (text, was_cut).

    A surrogate pair is never split.
    """
    if limit < 1:
        raise ValueError('limit must be at least 1')
    if len(text) <= limit and utf16_len(text) <= limit:
        return text, False
    data = text[:limit].encode('utf-16-le', 'surrogatepass')[:(limit - 1) * 2]
    if len(data) >= 2 and 0xD8 <= data[-1] <= 0xDB:  # a high surrogate whose partner was cut off
        data = data[:-2]
    return data.decode('utf-16-le', 'surrogatepass') + ELLIPSIS, True


def squash(text: str) -> str:
    """Every run of whitespace as one space, stripped."""
    return _WHITESPACE.sub(' ', text).strip()


def clip(text: str, limit: int) -> str:
    """Whitespace collapsed to single spaces, stripped, then cut to `limit` UTF-16 code units."""
    return cut_utf16(squash(text), limit)[0]
