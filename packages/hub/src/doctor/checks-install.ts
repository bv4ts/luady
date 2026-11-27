import { authModeOf } from '../config/defaults.js';
import { homedir } from 'node:os';
import { CODEX_SIGN_IN_AGAIN, codexSignInMoved, oldCodexSignIns } from '../media/codex.js';
import { checkModes, type ModeEntry } from '../config/modes.js';
import { remoteNoPasskey } from '../config/refusals.js';
import { isRemote } from '../config/remote.js';
import { probeSealed } from '../config/sealed-probe.js';
import type { Db } from '../core/contracts.js';
import { readFacts, stateOf } from '../setup/state.js';
import { MIGRATIONS } from '../db/migrate.js';
import { fail, pass, warn, type CheckResult, type DoctorInput } from './types.js';

/**
 * Each kind of config or startup refusal as one fixed sentence: a message can carry an address (bindHost), a server
 * name, a config key or a path, so the default output never prints it. The message itself is the detail (`--full`).
 */
const REFUSAL_SENTENCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^there is no config\.json yet/, 'there is no config.json yet (the first `npm start` writes one)'],
  [/^secrets\.env is missing/, 'secrets.env is missing (the first `npm start` writes it)'],
  [/^there is no database yet/, 'there is no database yet (the first `npm start` makes it)'],
  [/^cannot read /, 'config.json or secrets.env cannot be read'],
  [/ is not valid JSON$/, 'config.json is not valid JSON'],
  [/^invalid config .*: authMode: cfTeamDomain is set/, 'cfTeamDomain is set, but authMode does not say "cloudflare-access"'],
  [/^invalid config /, 'a field of config.json is missing, unknown or of the wrong kind'],
  [/^invalid secrets /, 'a value in secrets.env is missing or malformed'],
  [/counts as remote/, 'the install counts as remote, and "allowRemote" is not set'],
  [/needs an https publicOrigin/, 'a remote install needs an https publicOrigin'],
  [/needs at least one passkey/, 'a remote install needs at least one passkey'],
  [/"cloudflare-access" needs/, 'Cloudflare Access sign-in lacks one of its values'],
  [/in config\.json "servers"/, 'two servers in config.json share a name, or one uses a reserved name'],
  [/does not belong to this database/, 'the secrets file does not belong to this database'],
  [/belongs to another Unix user/, 'a file or folder the hub reads belongs to another user'],
];

/** The fixed sentence for a refusal message; an unknown message gets a plain one. */
export function refusalSentence(message: string, unknown = 'it could not be read'): string {
  return REFUSAL_SENTENCES.find(([pattern]) => pattern.test(message))?.[1] ?? unknown;
}

export function configCheck(input: DoctorInput): CheckResult {
  const where = `${input.paths.configPath} (secrets: ${input.paths.secretsPath})`;
  if (input.config === null) {
    const why = input.configError ?? 'it could not be read';
    const firstStart = why.includes('the first `npm start`');
    return fail('config', 'install', `config.json cannot be used: ${refusalSentence(why)}`,
      firstStart ? 'Run `npm start` once (on Linux or in WSL2): the first start writes it.' : 'Run `npm run doctor -- --full` for the exact line, fix it in config.json (or secrets.env), then start the hub again.',
      `${where}: ${why}`);
  }
  const mode = input.config.authMode ?? 'local';
  return pass('config', 'install', `config.json read (${mode} sign-in, ${input.config.servers.length} server(s) listed in it)`, where);
}

const modeText = (entry: ModeEntry): string =>
  `${entry.path}: ${entry.state}${entry.mode === null ? '' : ` (${entry.mode.toString(8)}, wants ${entry.want.toString(8)})`}`;

/** The owner-only folders and files; a missing optional file is not a problem here. */
export function modesCheck(input: DoctorInput): CheckResult | null {
  if (input.config === null) return null;
  if (input.probe.platform() === 'win32') {
    return warn('modes', 'install', 'File modes cannot be checked on Windows', 'Run the hub on Linux or in WSL2, where its files are owner-only.');
  }
  const entries = checkModes(input.config, { secretsPath: input.paths.secretsPath });
  const bad = entries.filter((entry) => entry.state === 'too-wide' || entry.state === 'foreign-owner');
  if (bad.length === 0) return pass('modes', 'install', `Owner-only folders and files are as they should be (${entries.filter((e) => e.state === 'ok').length} checked)`);
  const foreign = bad.filter((entry) => entry.state === 'foreign-owner').length;
  return fail('modes', 'install', `${bad.length} owned folder(s) or file(s) are open to others${foreign > 0 ? ` or belong to another user (${foreign})` : ''}`,
    'Start the hub once as its own user: it makes folders 0700 and files 0600. A file of another user must be given back (chown).',
    bad.map(modeText).join('\n'));
}

function appliedMigrations(db: Db): number[] {
  return db.prepare<[], { version: number }>('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
}

export function databaseCheck(input: DoctorInput): CheckResult | null {
  if (input.config === null) return null;
  if (input.db === null) {
    const why = input.dbError ?? 'unknown error';
    return fail('database', 'install', `The database cannot be opened: ${refusalSentence(why, 'the file cannot be opened (see --full)')}`,
      'Check the data folder and its free space; `npm start` makes the database on its first start.', input.dbError);
  }
  const applied = appliedMigrations(input.db);
  const latest = MIGRATIONS.at(-1)?.version ?? 0;
  if (applied.at(-1) === latest) return pass('database', 'install', `The database is up to date (${applied.length} migrations)`);
  return fail('database', 'install', `The database is at migration ${applied.at(-1) ?? 'none'} of ${latest}`,
    'Start the hub once: it applies the missing migrations.');
}

const count = (db: Db, sql: string): number => db.prepare<[], { n: number }>(sql).get()?.n ?? 0;

/**
 * The startup refusals that need the database: a remote install in local mode without a passkey, and sealed rows that
 * this SESSION_SECRET cannot open. The other startup refusals are reported by the config and modes checks above.
 */
export function refusalsCheck(input: DoctorInput): CheckResult | null {
  if (input.config === null || input.db === null) return null;
  const { config, db } = input;
  const refusals: string[] = [];
  if (isRemote(config) && authModeOf(config) === 'local' && count(db, 'SELECT COUNT(*) AS n FROM auth_passkeys') === 0) {
    refusals.push(remoteNoPasskey().message);
  }
  try {
    probeSealed(db, config.sessionSecret);
  } catch (err) {
    refusals.push(err instanceof Error ? err.message : 'the sealed rows cannot be opened');
  }
  if (refusals.length === 0) return pass('refusals', 'install', 'No startup refusal applies');
  const sentences = refusals.map((message) => refusalSentence(message, 'a startup check fails'));
  return fail('refusals', 'install', `The hub would refuse to start: ${sentences.join('; ')}.`,
    'Run `npm run doctor -- --full` for the exact lines, do what they say, then start the hub again.', refusals.join('\n'));
}


/**
 * A claimed install (its PIN set) with no owner_tz is a FAIL. One not claimed yet gets its zone when the owner claims it
 * on the website (the browser's zone, with the first PIN), so a passkey made before that PIN is no fault.
 */
export function ownerZoneCheck(input: DoctorInput): CheckResult | null {
  if (input.db === null) return null;
  const zone = input.db.prepare<[], { value_json: string }>("SELECT value_json FROM settings WHERE key = 'owner_tz'").get();
  if (zone !== undefined) return pass('owner-tz', 'install', 'Your time zone is set');
  if (readFacts(input.db).pinSet) {
    return fail('owner-tz', 'install', 'Your time zone is not set', 'Open Settings → General on the website and choose your time zone.');
  }
  return pass('owner-tz', 'install', 'Your time zone is set when you claim the hub on the website');
}

/**
 * The ChatGPT sign-in for pictures lives in the hub's own Codex home now: one made where an older release kept it (the
 * user's ~/.codex, or beside the data folder) is not used, so the owner is told to sign in again, never left guessing.
 */
export function codexSignInCheck(input: DoctorInput, home: string = homedir()): CheckResult | null {
  if (input.config === null) return null;
  const exists = (path: string): boolean => input.probe.stat(path) !== null;
  if (!codexSignInMoved(input.config.dataDir, home, exists)) return null;
  const fix = 'Open Accounts and limits in the office and press Connect under ChatGPT (pictures); then sign the old one out '
    + '(`codex logout` with CODEX_HOME set to its folder) or delete its auth.json.';
  // The old files' paths only in the detail, which `doctor --full` alone prints.
  return warn('codex-sign-in', 'install', CODEX_SIGN_IN_AGAIN, fix, oldCodexSignIns(input.config.dataDir, home, exists).join('\n'));
}

/** The first run: finished, or the step it waits at (claim and PIN keep every other page closed). */
export function setupCheck(input: DoctorInput): CheckResult | null {
  if (input.config === null || input.db === null) return null;
  const { step } = stateOf(readFacts(input.db), input.config);
  if (step === 'done') return pass('setup', 'install', 'The first run is finished');
  const fix = step === 'claim' || step === 'pin'
    ? 'Open the website and claim it; `npm run luady -- setup-code` prints a new setup code (or `npm run luady -- login`, on this machine).'
    : 'Open the website: the setup goes on where it stopped.';
  return warn('setup', 'install', `The first run waits at its ${step} step`, fix);
}

/** The fleet key: made at the first start, 0600, never shown. */
export function fleetKeyCheck(input: DoctorInput): CheckResult | null {
  if (input.config === null) return null;
  const key = input.probe.stat(input.config.fleetKeyPath);
  if (key === null) return warn('fleet-key', 'install', 'The fleet key does not exist yet', 'Start the hub once: it makes the key.', input.config.fleetKeyPath);
  if (input.probe.platform() !== 'win32' && (key.mode & 0o077) !== 0) {
    return fail('fleet-key', 'install', `The fleet key is readable by others (${key.mode.toString(8)})`, 'Run `chmod 600` on it, or start the hub, which tightens it.',
      input.config.fleetKeyPath);
  }
  return pass('fleet-key', 'install', 'The fleet key is there, owner-only', input.config.fleetKeyPath);
}
