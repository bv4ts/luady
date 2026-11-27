/** Per-program allow rules for the read-only classifier. */

export type ProgramVerdict =
  | { readonly ok: true; readonly recursive: boolean }
  | { readonly ok: false; readonly reason: string };

type ArgRule = (args: readonly string[]) => string | null;

const FORBIDDEN_PROGRAMS: ReadonlySet<string> = new Set(['eval', 'exec', 'source', '.', 'sudo', 'su', 'xargs']);
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const SHELL_COMMAND_FLAG_RE = /^-[A-Za-z]*c/;
const GREP_RECURSIVE_OPTIONS = ['recursive', 'dereference-recursive', 'directories'];
const GREP_RECURSIVE_SHORT_RE = /^-[A-Za-z0-9]*[rRd]/;
const RG_EXEC_OPTIONS = ['pre', 'pre-glob', 'hostname-bin'];
const FIND_WRITERS = ['-delete', '-exec', '-ok', '-fprint', '-fls'];
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show', 'branch']);
const GIT_WRITING_OPTIONS = ['output', 'ext-diff'];
const GIT_BRANCH_LONG: ReadonlySet<string> = new Set([
  '--all', '--remotes', '--verbose', '--list', '--show-current', '--color', '--no-color', '--column',
  '--no-column', '--ignore-case', '--no-abbrev', '--merged', '--no-merged', '--contains', '--no-contains',
]);
const GIT_BRANCH_VALUED = [
  '--sort=', '--format=', '--contains=', '--no-contains=', '--merged=', '--no-merged=', '--points-at=',
  '--abbrev=', '--color=', '--column=',
];
const GIT_BRANCH_SHORT_RE = /^-[arvli]+$/;
const DOCKER_READ: ReadonlySet<string> = new Set(['ps', 'logs', 'images']);
const SYSTEMCTL_FLAGS: ReadonlySet<string> = new Set([
  '--no-pager', '--full', '-l', '--all', '-a', '--plain', '--no-legend', '--user', '-n',
]);
const SYSTEMCTL_VALUED_RE = /^(--lines=\d{1,6}|-n\d{1,6})$/;
const JOURNAL_ATTACHED_RE = /^(-n\d{1,6}|-u[A-Za-z0-9@._:-]+|--since=.+)$/;
const JOURNAL_VALUED: ReadonlySet<string> = new Set(['-n', '-u', '--since']);

/** GNU-style long options may be abbreviated, so `--outp` must count as `--output`. */
function longOptionMatches(arg: string, names: readonly string[]): boolean {
  if (!arg.startsWith('--')) return false;
  const name = (arg.slice(2).split('=')[0] ?? '').toLowerCase();
  return name.length > 0 && names.some((full) => full.startsWith(name) || name.startsWith(full));
}

const anyArgs: ArgRule = () => null;

function onlyArgs(program: string, ...allowed: string[]): ArgRule {
  return (args) =>
    args.length === 1 && allowed.includes(args[0] ?? '') ? null : `${program} is only allowed as "${program} ${allowed[0] ?? ''}"`;
}

function rgRule(args: readonly string[]): string | null {
  const bad = args.find((arg) => longOptionMatches(arg, RG_EXEC_OPTIONS));
  return bad === undefined ? null : `rg option "${bad}" runs other programs`;
}

function findRule(args: readonly string[]): string | null {
  const bad = args.find((arg) => FIND_WRITERS.some((writer) => arg.startsWith(writer)));
  return bad === undefined ? null : `find action "${bad}" can change files or run programs`;
}

function isReadOnlyBranchOption(arg: string): boolean {
  return GIT_BRANCH_LONG.has(arg) || GIT_BRANCH_SHORT_RE.test(arg) || GIT_BRANCH_VALUED.some((prefix) => arg.startsWith(prefix));
}

function gitBranchRule(args: readonly string[]): string | null {
  const listing = args.some((arg) => arg === '--list' || (GIT_BRANCH_SHORT_RE.test(arg) && arg.includes('l')));
  const bad = args.find((arg) => (arg.startsWith('-') ? !isReadOnlyBranchOption(arg) : !listing));
  if (bad === undefined) return null;
  return bad.startsWith('-') ? `git branch option "${bad}" is not read-only` : 'git branch with a name creates a branch';
}

function gitRule(args: readonly string[]): string | null {
  const rest = args[0] === '--no-pager' ? args.slice(1) : args;
  const [sub, ...subArgs] = rest;
  if (sub === 'remote') {
    const verbose = subArgs.length === 1 && (subArgs[0] === '-v' || subArgs[0] === '--verbose');
    return verbose ? null : 'only "git remote -v" is read-only';
  }
  if (sub === undefined || !GIT_READ_SUBCOMMANDS.has(sub)) return `"git ${sub ?? ''}" is not read-only (no global options either)`;
  const writer = subArgs.find((arg) => longOptionMatches(arg, GIT_WRITING_OPTIONS));
  if (writer !== undefined) return `git option "${writer}" can write files or run programs`;
  return sub === 'branch' ? gitBranchRule(subArgs) : null;
}

function dockerRule(args: readonly string[]): string | null {
  const [sub, ...rest] = args;
  if (sub !== undefined && DOCKER_READ.has(sub)) return null;
  if (sub === 'stats') return rest.includes('--no-stream') ? null : 'docker stats needs --no-stream';
  return `"docker ${sub ?? ''}" is not read-only (no global options either)`;
}

function systemctlRule(args: readonly string[]): string | null {
  const badFlag = args.find((arg) => arg.startsWith('-') && !SYSTEMCTL_FLAGS.has(arg) && !SYSTEMCTL_VALUED_RE.test(arg));
  if (badFlag !== undefined) return `systemctl option "${badFlag}" is not allowed`;
  const verb = args.find((arg) => !arg.startsWith('-'));
  return verb === 'status' ? null : `"systemctl ${verb ?? ''}" is not read-only`;
}

function journalctlRule(args: readonly string[]): string | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (arg === '--no-pager' || JOURNAL_ATTACHED_RE.test(arg)) {
      i += 1;
      continue;
    }
    if (!JOURNAL_VALUED.has(arg)) return `journalctl option "${arg}" is not allowed (only -n, --since, -u, --no-pager)`;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('-') || (arg === '-n' && !/^\d{1,6}$/.test(value))) {
      return `journalctl ${arg} needs a valid value`;
    }
    i += 2;
  }
  return null;
}

const ANY_ARGS_PROGRAMS = ['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'du', 'df', 'free', 'uptime', 'ps', 'which', 'whereis'];

const PROGRAM_RULES: ReadonlyMap<string, ArgRule> = new Map<string, ArgRule>([
  ...ANY_ARGS_PROGRAMS.map((program): [string, ArgRule] => [program, anyArgs]),
  ['rg', rgRule],
  ['find', findRule],
  ['git', gitRule],
  ['docker', dockerRule],
  ['systemctl', systemctlRule],
  ['journalctl', journalctlRule],
  ['top', onlyArgs('top', '-bn1')],
  ['node', onlyArgs('node', '-v', '--version')],
  ['npm', onlyArgs('npm', '-v', '--version')],
  ['php', onlyArgs('php', '-v', '--version')],
  ['composer', onlyArgs('composer', '--version', '-V')],
  ['python3', onlyArgs('python3', '--version', '-V')],
]);

function forbiddenReason(program: string, args: readonly string[]): string | null {
  if (FORBIDDEN_PROGRAMS.has(program)) return `"${program}" can run arbitrary commands`;
  if (SHELLS.has(program) && args.some((arg) => SHELL_COMMAND_FLAG_RE.test(arg))) return `"${program} -c" runs arbitrary commands`;
  return null;
}

function grepIsRecursive(args: readonly string[]): boolean {
  return args.some((arg) => longOptionMatches(arg, GREP_RECURSIVE_OPTIONS) || GREP_RECURSIVE_SHORT_RE.test(arg));
}

/** Checks one pipeline segment's program and arguments against the allow-list. */
export function checkProgram(words: readonly string[]): ProgramVerdict {
  const [program, ...args] = words;
  if (program === undefined || program === '') return { ok: false, reason: 'missing program name' };
  const forbidden = forbiddenReason(program, args);
  if (forbidden !== null) return { ok: false, reason: forbidden };
  const rule = PROGRAM_RULES.get(program);
  if (rule === undefined) return { ok: false, reason: `"${program}" is not in the read-only allow-list` };
  const problem = rule(args);
  if (problem !== null) return { ok: false, reason: problem };
  return { ok: true, recursive: program === 'rg' || (program === 'grep' && grepIsRecursive(args)) };
}
