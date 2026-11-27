import { HOST_ID_RE, HOST_PATH_RE } from '@luady/shared';
import { ValidationError } from '../core/errors.js';
import { shQuote } from '../core/ids.js';

/**
 * The fixed remote scripts: besides luady-ctl and the terminal, the only commands the hub ever runs on
 * a server. Each is a constant POSIX `sh` text, run as `sh -c '<constant>' luady <shQuote(arg)…>`: no string from the
 * user, the database or a server is ever spliced into the text; values reach the script only as quoted positional
 * arguments, each checked against the script's own grammar first.
 *
 * Every text is ONE line (`;`-joined statements), so a login shell of any family (sh, bash, zsh, fish, csh) hands it to
 * sh unchanged, and holds no `\\` or `\'`, the two escapes fish reads inside single quotes.
 */

/** `printf` one `key=value` line; the hub parses every value as hostile text (hosts/preflight.ts). */
const KV = "kv() { printf '%s=%s\\n' \"$1\" \"$2\"; }";

const PREFLIGHT: readonly string[] = [
  'c=${1:-"$HOME/.local/bin/claude"}',
  'p=${2:-"$HOME/projects"}',
  KV,
  'kv os "$(uname -s 2>/dev/null)"',
  'kv home "$HOME"',
  'kv user "$(id -un 2>/dev/null)"',
  `if command -v python3 >/dev/null 2>&1; then kv python "$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"; else kv python ""; fi`,
  'if command -v tmux >/dev/null 2>&1; then kv tmux "$(tmux -V 2>/dev/null | head -n 1)"; else kv tmux ""; fi',
  'if command -v tar >/dev/null 2>&1; then kv tar yes; else kv tar no; fi',
  'if command -v mktemp >/dev/null 2>&1; then kv mktemp yes; else kv mktemp no; fi',
  'if [ -x "$c" ]; then kv claude "$c"; kv claude_version "$("$c" --version 2>/dev/null | head -n 1)"; else kv claude ""; kv claude_version ""; fi',
  'if [ -d "$p" ]; then kv projects yes; else kv projects no; fi',
  'f="$HOME/.luady/state/config.json"',
  `if [ -f "$f" ]; then kv kit_alias "$(grep -o '"host_alias": *"[^"]*"' "$f" 2>/dev/null | head -n 1)"; else kv kit_alias ""; fi`,
  'v="$HOME/.luady/lib/luady_kit/__init__.py"',
  `if [ -f "$v" ]; then kv kit_version "$(grep -m 1 '^__version__' "$v" 2>/dev/null)"; else kv kit_version ""; fi`,
];

/** The kit installer (mktemp, unpack, run, remove): the payload arrives on stdin, the installer gets "$@". */
const KIT: readonly string[] = [
  'command -v python3 >/dev/null 2>&1 || { echo "python3 was not found" >&2; exit 69; }',
  'd=$(mktemp -d "${TMPDIR:-/tmp}/luady-kit.XXXXXX") || exit 70',
  `trap 'rm -rf "$d"' EXIT`,
  `trap 'rm -rf "$d"; exit 1' HUP INT TERM`,
  'tar -xzf - -C "$d" || exit 71',
  'python3 "$d/install.py" "$@"',
];

/**
 * Removes the hub's key from authorized_keys: every line holding the hub's blob goes, nothing else is touched. The file is
 * replaced only after a clean filter: grep must end with 0 (lines kept) or 1 (none kept), and an empty result is
 * accepted only when the original held nothing but the hub's lines. On anything else the temp file goes, the original
 * stays as it was, and the script says why and ends non-zero.
 */
const KEY_REMOVE: readonly string[] = [
  'case "$1" in AAAAC3NzaC1lZDI1NTE5*) ;; *) echo "not a fleet key" >&2; exit 64 ;; esac',
  'ak="$HOME/.ssh/authorized_keys"',
  'if [ ! -f "$ak" ] || ! grep -qF -- "$1" "$ak"; then echo absent; exit 0; fi',
  't=$(mktemp "$HOME/.ssh/.authorized_keys.XXXXXX") || { echo "no temporary file could be made in ~/.ssh; authorized_keys left as it was" >&2; exit 70; }',
  'grep -vF -- "$1" "$ak" > "$t"',
  'rc=$?',
  'if [ "$rc" -gt 1 ]; then rm -f "$t"; echo "the key line could not be filtered out (grep ended with $rc); authorized_keys left as it was" >&2; exit 74; fi',
  'if [ ! -s "$t" ] && grep -qvF -- "$1" "$ak"; then rm -f "$t"; echo "the filtered file came out empty although other lines exist; authorized_keys left as it was" >&2; exit 75; fi',
  'if chmod 0600 "$t" && mv -f "$t" "$ak"; then echo removed; else rm -f "$t"; echo "authorized_keys could not be replaced; it was left as it was" >&2; exit 76; fi',
];

interface FixedScript {
  readonly text: string;
  /** Throws ValidationError unless `args` fit this script's grammar exactly. */
  readonly check: (args: readonly string[]) => void;
}

const BLOB_RE = /^AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]{40,120}={0,2}$/;
/** The alias line the preflight prints from the kit's config.json; the hub keeps only a host-id-shaped value. */
export const KIT_ALIAS_LINE_RE = /^"host_alias": *"([A-Za-z0-9._-]{1,32})"$/;

function refuse(what: string): never {
  throw new ValidationError(`fixed script: ${what}`);
}

function checkPreflight(args: readonly string[]): void {
  if (args.length !== 2) refuse('preflight takes the Claude Code path and the projects folder');
  for (const arg of args) if (arg !== '' && !HOST_PATH_RE.test(arg)) refuse('preflight paths must be absolute and safe');
}

function checkKeyRemove(args: readonly string[]): void {
  if (args.length !== 1 || !BLOB_RE.test(args[0] ?? '')) refuse('key-remove takes one ed25519 key blob');
}

/** `--uninstall` alone, or `--host-alias <id>` then at most one `--projects-root` and one `--claude-bin`, in this order. */
function checkKit(args: readonly string[]): void {
  if (args.length === 1 && args[0] === '--uninstall') return;
  if (args[0] !== '--host-alias' || !HOST_ID_RE.test(args[1] ?? '')) refuse('kit installs need --host-alias <host id>');
  const rest = args.slice(2);
  const flags = ['--projects-root', '--claude-bin'];
  let next = 0;
  for (let i = 0; i < rest.length; i += 2) {
    const at = flags.indexOf(rest[i] ?? '');
    if (at < next) refuse('kit flags are --projects-root then --claude-bin, each once');
    if (!HOST_PATH_RE.test(rest[i + 1] ?? '')) refuse('kit paths must be absolute and safe');
    next = at + 1;
  }
}

const script = (lines: readonly string[], check: FixedScript['check']): FixedScript => Object.freeze({ text: lines.join('; '), check });

/** The frozen table: nothing else ever reaches `sh -c` on a server. */
export const FIXED_SCRIPTS = Object.freeze({
  preflight: script(PREFLIGHT, checkPreflight),
  kit: script(KIT, checkKit),
  'key-remove': script(KEY_REMOVE, checkKeyRemove),
} as const);

export type FixedScriptId = keyof typeof FIXED_SCRIPTS;
export const FIXED_SCRIPT_IDS = Object.freeze(Object.keys(FIXED_SCRIPTS) as FixedScriptId[]);

function scriptOf(id: FixedScriptId): FixedScript {
  if (!Object.hasOwn(FIXED_SCRIPTS, id)) refuse(`unknown script ${JSON.stringify(String(id)).slice(0, 40)}`);
  return FIXED_SCRIPTS[id];
}

/** The constant text of one script (tests read it). */
export function scriptText(id: FixedScriptId): string {
  return scriptOf(id).text;
}

/** `sh -c '<constant>' luady <shQuote(arg)…>`: the only command line runFixed sends. */
export function compileFixed(id: FixedScriptId, args: readonly string[]): string {
  const fixed = scriptOf(id);
  fixed.check(args);
  return ['sh', '-c', shQuote(fixed.text), 'luady', ...args.map((arg) => shQuote(arg))].join(' ');
}

/** The installer's arguments for one host: its id as the alias, and its folders when the row has them. */
export function installArgs(opts: { alias: string; projectsRoot: string | null; claudeBin: string | null }): string[] {
  const args = [
    '--host-alias', opts.alias,
    ...(opts.projectsRoot === null ? [] : ['--projects-root', opts.projectsRoot]),
    ...(opts.claudeBin === null ? [] : ['--claude-bin', opts.claudeBin]),
  ];
  checkKit(args);
  return args;
}

export function uninstallArgs(): string[] {
  return ['--uninstall'];
}
