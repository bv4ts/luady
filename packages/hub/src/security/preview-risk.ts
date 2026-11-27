import { LIMITS, type PermissionPreview } from '@luady/shared';
import { referencesDeniedPath } from './risk-paths.js';
import { classifyCommand, classifyExec } from './risk.js';

/**
 * How an approval card marks a permission request. `security/risk.ts` answers only "is this provably read-only?"
 * (tier 1 for everything else), so on its own it would mark `npm test` as dangerous: it supplies `safe` and the
 * protected-path check, and the short pattern list below supplies `risky` (delete, force push, deploy,
 * drop, production paths).
 */
export type PreviewRisk = { readonly level: 'safe' | 'normal' | 'risky'; readonly reason: string };

const PRODUCTION_RE = /(^|[\s"'=])(\/var\/www|\/etc\/)|\bprod(uction)?\b|\.env\b/i;
/** Secrets outside the deny list: cloud and Claude credentials, private keys (not `.pub`), the kit's own folder. */
const PROTECTED_RE = /\.aws\/credentials\b|\bid_(rsa|dsa|ecdsa|ed25519)(?!\.pub)\b|\.(pem|key)\b|\.claude\/(settings|\.credentials)\.json\b|\.luady\//i;

/** `git` with any global options before the subcommand (`-C <dir>`, `-c k=v`, `--no-pager`, …). */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--[a-z][\w-]*(?:=\S+)?))*\s+`;
/** The rest of one simple command: options may come in any order, but not past `;`, `&`, `|` or a newline. */
const ARGS = String.raw`[^;&|\n]*`;
const INTERPRETERS = 'sh|bash|zsh|dash|ksh|fish|python[\\d.]*|node|perl|ruby|php';

/** First match wins. */
const RISKY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(String.raw`\brm\b${ARGS}\s(-[a-z]*[rf][a-z]*\b|--(recursive|force)\b)`, 'i'), 'deletes files'],
  [new RegExp(String.raw`\bfind\b${ARGS}\s(-delete\b|-exec\s+rm\b)`, 'i'), 'deletes files'],
  [new RegExp(String.raw`${GIT}push\b.*(--force\b|--force-with-lease\b|\s-f\b)`, 'i'), 'force push'],
  [new RegExp(String.raw`${GIT}(reset\s+--hard\b|clean\b${ARGS}(\s-[a-z]*f|\s--force\b))`, 'i'), 'discards work'],
  [new RegExp(String.raw`${GIT}branch\b${ARGS}\s-D\b`), 'discards work'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'drops data'],
  [/\bTRUNCATE\s+["'`]?\w/, 'drops data'],
  [
    /\b(deploy\w*|kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|docker(-|\s+)compose\s+down|systemctl\s+(stop|restart|disable))\b/i,
    'deploys or restarts a service',
  ],
  [PRODUCTION_RE, 'touches production'],
  [new RegExp(String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(\S*\/)?(${INTERPRETERS})\b`, 'i'), 'runs a downloaded script'],
  [/\b(sudo|mkfs\w*)\b|\bdd\s+if=/i, 'system-level change'],
  [new RegExp(String.raw`\b(chmod|chown)\b${ARGS}\s(-[a-zA-Z]*R|--recursive\b)`), 'system-level change'],
];

/** The deny list of the action classifier, plus the secrets above. */
function isProtected(text: string): boolean {
  return referencesDeniedPath(text) || PROTECTED_RE.test(text);
}

const NORMAL: PreviewRisk = { level: 'normal', reason: '' };
/** What the kit writes where it removed a secret: the hub cannot see what stood there. */
const REDACTED = '[redacted]';
const ELLIPSIS = '…';

/** A kit-1 `input_preview` was cut when it reached its length limit (the kit may end it with `…`). */
function legacyWhole(text: string): boolean {
  return text.length < LIMITS.permissionInputPreview && !text.endsWith(ELLIPSIS);
}

/**
 * `whole` = the hub saw the entire command. Only then can it be `safe`: a redacted or cut command may hide anything
 * after the visible part. What is visible can still make it `risky`.
 */
export function riskOfCommand(command: string, cwd: string | null, whole = true): PreviewRisk {
  const hit = RISKY_PATTERNS.find(([pattern]) => pattern.test(command));
  if (hit !== undefined) return { level: 'risky', reason: hit[1] };
  if (isProtected(command)) return { level: 'risky', reason: 'protected path' };
  if (!whole || command.includes(REDACTED)) return NORMAL;
  const verdict = cwd === null ? classifyCommand(command) : classifyExec(command, cwd);
  return verdict.tier === 0 ? { level: 'safe', reason: 'read-only command' } : NORMAL;
}

function riskOfPath(path: string | null): PreviewRisk {
  if (path === null) return NORMAL;
  if (PRODUCTION_RE.test(path)) return { level: 'risky', reason: 'touches production' };
  if (isProtected(path)) return { level: 'risky', reason: 'protected path' };
  return NORMAL;
}

export function riskOfPermission(input: { toolName: string; inputPreview: string; preview: PermissionPreview | null }): PreviewRisk {
  const { preview } = input;
  if (preview === null) return input.toolName === 'Bash' ? riskOfCommand(input.inputPreview, null, legacyWhole(input.inputPreview)) : NORMAL;
  switch (preview.kind) {
    case 'command':
      return preview.command === null
        ? riskOfCommand(input.inputPreview, preview.cwd, !preview.truncated && legacyWhole(input.inputPreview))
        : riskOfCommand(preview.command, preview.cwd, !preview.truncated);
    case 'edit':
    case 'write':
      return riskOfPath(preview.path);
    case 'other':
      return NORMAL;
  }
}
