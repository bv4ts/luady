import { HOST_PATH_RE } from '@luady/shared';
import { KIT_ALIAS_LINE_RE } from '../fleet/fixed-scripts.js';
import { MIN_PYTHON, versionOf, type Preflight as LocalPreflight } from '../fleet/local-kit.js';
import { cleanText } from './clean.js';

/**
 * Preflight in plain words. The remote script prints `key=value` lines; everything it
 * prints is hostile text: only known keys are read, each value is bounded, stripped of control characters and kept only
 * when it fits its own pattern. Nothing here is ever logged raw or rendered as HTML.
 */
export const PREFLIGHT_KEYS = [
  'os', 'home', 'user', 'python', 'tmux', 'tar', 'mktemp', 'claude', 'claude_version', 'projects', 'kit_alias', 'kit_version',
] as const;
export type PreflightKey = (typeof PREFLIGHT_KEYS)[number];

const VALUE_MAX = 200;
const LINES_MAX = 64;
const KIT_VERSION_LINE_RE = /^__version__\s*=\s*['"]([0-9A-Za-z.+-]{1,32})['"]/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const OS_RE = /^[A-Za-z0-9_.-]{1,32}$/;

/** What the hub learned, already checked: every value here passed its own pattern. */
export interface PreflightReport {
  /** The record the website shows (HostCheckDTO.preflight); `ready` is `yes` when nothing blocks the kit. */
  readonly values: Readonly<Record<string, string>>;
  /** What to fix, in plain words; the alias line is a warning and does not block. */
  readonly missing: readonly string[];
  readonly ready: boolean;
  readonly home: string | null;
  readonly kitAlias: string | null;
  readonly kitVersion: string | null;
  readonly claudeVersion: string | null;
}

/** One hostile value: control and direction characters dropped, length bounded (hosts/clean.ts). */
function clean(value: string): string {
  return cleanText(value, VALUE_MAX);
}

/** The known `key=value` lines of the script's output; the first of each key wins. */
export function readPreflightLines(stdout: string): Partial<Record<PreflightKey, string>> {
  const out: Partial<Record<PreflightKey, string>> = {};
  for (const line of stdout.split('\n').slice(0, LINES_MAX)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at) as PreflightKey;
    if (!(PREFLIGHT_KEYS as readonly string[]).includes(key) || key in out) continue;
    out[key] = clean(line.slice(at + 1));
  }
  return out;
}

const match = (re: RegExp, text: string | undefined): string | null => (text === undefined ? null : re.exec(text)?.[1] ?? null);
const fits = (re: RegExp, text: string | undefined): string | null => (text !== undefined && re.test(text) ? text : null);

function pythonItem(python: string | null): string | null {
  const found = versionOf(python);
  const need = `Python ${MIN_PYTHON.join('.')} or later (python3)`;
  if (found === null) return need;
  const [major = 0, minor = 0] = found;
  const ok = major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
  return ok ? null : `${need}; this server has Python ${major}.${minor}`;
}

/** The alias warning: the kit there answers to another name, and installing gives it this host's name instead. */
export function aliasItem(kitAlias: string | null, hostId: string): string | null {
  if (kitAlias === null || kitAlias === '' || kitAlias === hostId) return null;
  return `The kit there was installed for another name (${kitAlias}). Installing it here renames it to ${hostId}.`;
}

function osItem(os: string | null): string | null {
  if (os === 'Darwin') return 'This is a Mac (macOS). The kit runs on Linux servers for now.';
  return null;
}

interface Parsed {
  readonly os: string | null;
  readonly home: string | null;
  readonly user: string | null;
  readonly python: string | null;
  readonly tmux: string | null;
  readonly claude: string | null;
  readonly claudeVersion: string | null;
  readonly kitAlias: string | null;
  readonly kitVersion: string | null;
  readonly lines: Partial<Record<PreflightKey, string>>;
}

function parse(stdout: string): Parsed {
  const lines = readPreflightLines(stdout);
  return {
    os: fits(OS_RE, lines.os),
    home: fits(HOST_PATH_RE, lines.home),
    user: fits(USER_RE, lines.user),
    python: match(/^(\d{1,2}\.\d{1,3})$/, lines.python),
    tmux: match(/^tmux\s+([0-9A-Za-z.-]{1,16})/, lines.tmux),
    claude: fits(HOST_PATH_RE, lines.claude),
    claudeVersion: match(/(\d{1,4}\.\d{1,4}(?:\.\d{1,6})?)/, lines.claude_version),
    kitAlias: match(KIT_ALIAS_LINE_RE, lines.kit_alias),
    kitVersion: match(KIT_VERSION_LINE_RE, lines.kit_version),
    lines,
  };
}

/**
 * The remote preflight's output for host `hostId`: what is there, and what to fix first. `claudeAt` names the Claude
 * Code path the owner should install to (the host's own, else the kit's default).
 */
export function parsePreflight(stdout: string, hostId: string, claudeAt = '~/.local/bin/claude'): PreflightReport {
  const p = parse(stdout);
  const blocking = [
    osItem(p.os),
    pythonItem(p.python),
    p.tmux === null ? 'tmux' : null,
    p.lines.tar === 'yes' ? null : 'tar',
    p.lines.mktemp === 'yes' ? null : 'mktemp',
    p.claude === null ? `Claude Code at ${claudeAt}` : null,
  ].filter((item): item is string => item !== null);
  const alias = aliasItem(p.kitAlias, hostId);
  const values: Record<string, string> = {
    os: p.os ?? '', home: p.home ?? '', user: p.user ?? '', python: p.python ?? '', tmux: p.tmux ?? '',
    tar: p.lines.tar === 'yes' ? 'yes' : 'no', mktemp: p.lines.mktemp === 'yes' ? 'yes' : 'no', claude: p.claude ?? '',
    claude_version: p.claudeVersion ?? '', projects: p.lines.projects === 'yes' ? 'yes' : 'no', kit_alias: p.kitAlias ?? '',
    kit_version: p.kitVersion ?? '', ready: blocking.length === 0 ? 'yes' : 'no',
  };
  return {
    values, missing: alias === null ? blocking : [...blocking, alias], ready: blocking.length === 0, home: p.home,
    kitAlias: p.kitAlias, kitVersion: p.kitVersion, claudeVersion: p.claudeVersion,
  };
}

/** This computer's preflight (fleet/local-kit.ts) in the same shape, with the platform and alias checks added. */
export function localReport(local: LocalPreflight, opts: {
  platform: NodeJS.Platform; hostId: string; home: string; kitAlias: string | null; kitVersion: string | null; projects: boolean;
}): PreflightReport {
  const platform = opts.platform === 'darwin' ? 'This computer is a Mac (macOS). The kit runs on Linux for now.'
    : opts.platform === 'win32' ? 'This computer runs Windows. The kit runs on Linux for now.' : null;
  const blocking = [...(platform === null ? [] : [platform]), ...local.missing];
  const alias = aliasItem(opts.kitAlias, opts.hostId);
  const values: Record<string, string> = {
    os: opts.platform, home: opts.home, python: local.python ?? '', tmux: local.tmux ?? '', claude_version: local.claude ?? '',
    projects: opts.projects ? 'yes' : 'no', kit_alias: opts.kitAlias ?? '', kit_version: opts.kitVersion ?? '',
    ready: blocking.length === 0 ? 'yes' : 'no',
  };
  return {
    values, missing: alias === null ? blocking : [...blocking, alias], ready: blocking.length === 0, home: opts.home,
    kitAlias: opts.kitAlias, kitVersion: opts.kitVersion, claudeVersion: local.claude,
  };
}
