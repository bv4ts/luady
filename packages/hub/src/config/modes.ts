import { chmodSync, readdirSync, statSync, type Stats } from 'node:fs';
import { posix } from 'node:path';
import type { HubConfig, Logger } from '../core/contracts.js';
import { addonsDir, databaseFiles, hubTokenPath, managerHomeOf, outboxDir } from './defaults.js';
import { DIR_MODE, FILE_MODE, ensureDir } from './files.js';
import { foreignOwner, guardedForeignOwner, writableByOthers } from './refusals.js';

const { join } = posix;

/** The process creates everything owner-only from its first line on. */
export const PROCESS_UMASK = 0o077;

export interface ModePaths {
  /** The secrets file. */
  readonly secretsPath: string;
  /** Extra folders the hub owns, e.g. the default config folder. */
  readonly extraDirs?: readonly string[];
  /**
   * Paths the hub reads but may not own (config.json, and the folders of config.json and secrets.env, which may be
   * root's): no other Unix user may write them. The hub's own are tightened; anyone else's that others can write is
   * refused. config.json names the binaries the hub runs.
   */
  readonly guarded?: readonly string[];
}

export interface ModeOptions extends ModePaths {
  /** The hub's Unix user; `process.getuid()` when absent (tests pass another one). */
  readonly uid?: number;
  readonly platform?: NodeJS.Platform;
}

export type ModeState = 'ok' | 'missing' | 'too-wide' | 'foreign-owner';

export interface ModeEntry {
  readonly path: string;
  readonly kind: 'dir' | 'file';
  /** The mode it must have: 0700 for a folder, 0600 for a file. */
  readonly want: number;
  /** The permission bits found; null when it does not exist. */
  readonly mode: number | null;
  readonly state: ModeState;
}

/** The folders the hub creates and owns: dataDir, brainDir, runDir, managerHome, addons/ and outbox/. */
export function ownedDirs(config: HubConfig, extra: readonly string[] = []): string[] {
  return [config.dataDir, config.brainDir, config.runDir, managerHomeOf(config), addonsDir(config), outboxDir(config), ...extra];
}

function addonTokens(config: HubConfig): string[] {
  try {
    return readdirSync(addonsDir(config)).filter((name) => name.endsWith('.token')).map((name) => join(addonsDir(config), name));
  } catch {
    return [];
  }
}

/** The files that must be 0600: the database with -wal and -shm, secrets.env, the fleet key, hub-token, add-on tokens. */
export function ownedFiles(config: HubConfig, secretsPath: string): string[] {
  return [...databaseFiles(config), secretsPath, config.fleetKeyPath, hubTokenPath(config), ...addonTokens(config)];
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function entryOf(path: string, kind: 'dir' | 'file', uid: number): ModeEntry {
  const want = kind === 'dir' ? DIR_MODE : FILE_MODE;
  const stats = statOrNull(path);
  if (stats === null) return { path, kind, want, mode: null, state: 'missing' };
  const mode = stats.mode & 0o777;
  if (stats.uid !== uid) return { path, kind, want, mode, state: 'foreign-owner' };
  return { path, kind, want, mode, state: (mode & ~want) === 0 ? 'ok' : 'too-wide' };
}

function currentUid(options: { uid?: number }): number {
  return options.uid ?? process.getuid?.() ?? -1;
}

/**
 * Reads the mode and owner of every folder and file the hub owns, changing nothing (`doctor` prints it). On Windows
 * there are no Unix modes: the list is empty.
 */
export function checkModes(config: HubConfig, options: ModeOptions): ModeEntry[] {
  if ((options.platform ?? process.platform) === 'win32') return [];
  const uid = currentUid(options);
  return [
    ...ownedDirs(config, options.extraDirs).map((path) => entryOf(path, 'dir', uid)),
    ...ownedFiles(config, options.secretsPath).map((path) => entryOf(path, 'file', uid)),
  ];
}

/**
 * Creates the owned folders at 0700, then refuses a folder or file owned by another Unix user (`foreign-owner`) and tightens
 * a wider mode to 0700 or 0600, with a warning. Run before the database opens, and again after.
 */
export type GuardedVerdict = 'ok' | 'tighten' | 'refuse-writable' | 'refuse-owner';

/**
 * What a guarded path's owner and mode mean: the hub's own is fine, or tightened when group or others can write it;
 * root's is fine while nobody else can write it; any other user's is refused, whatever its mode (that user can write).
 */
export function guardedVerdict(owner: number, mode: number, uid: number): GuardedVerdict {
  const othersWrite = (mode & 0o022) !== 0;
  if (owner === uid) return othersWrite ? 'tighten' : 'ok';
  if (owner !== 0) return 'refuse-owner';
  return othersWrite ? 'refuse-writable' : 'ok';
}

/** The guarded paths: the hub's own lose group and other write; root's must be unwritable by others; others refused. */
function enforceGuarded(paths: readonly string[], uid: number, log: Logger | undefined): void {
  for (const path of paths) {
    const stats = statOrNull(path);
    if (stats === null) continue;
    const verdict = guardedVerdict(stats.uid, stats.mode, uid);
    if (verdict === 'refuse-owner') throw guardedForeignOwner(path);
    if (verdict === 'refuse-writable') throw writableByOthers(path);
    if (verdict === 'ok') continue;
    chmodSync(path, stats.mode & 0o7755);
    log?.warn({ path, was: (stats.mode & 0o777).toString(8) }, 'modes: removed write access for other users');
  }
}

/** The loggers already told that Windows has no Unix modes: one warning per hub, though the modes are enforced twice. */
const toldNoModes = new WeakSet<Logger>();

function warnNoModes(log: Logger | undefined): void {
  if (log === undefined || toldNoModes.has(log)) return;
  toldNoModes.add(log);
  log.warn('modes: file modes are not enforced on Windows, so the secrets and the database are not owner-only; run the hub on Linux or in WSL2');
}

export function enforceModes(config: HubConfig, options: ModeOptions & { readonly log?: Logger }): ModeEntry[] {
  for (const dir of ownedDirs(config, options.extraDirs)) ensureDir(dir);
  if ((options.platform ?? process.platform) === 'win32') warnNoModes(options.log);
  else enforceGuarded(options.guarded ?? [], currentUid(options), options.log);
  const entries = checkModes(config, options);
  const foreign = entries.find((entry) => entry.state === 'foreign-owner');
  if (foreign !== undefined) throw foreignOwner(foreign.path);
  for (const entry of entries.filter((item) => item.state === 'too-wide')) {
    chmodSync(entry.path, entry.want);
    options.log?.warn({ path: entry.path, was: entry.mode?.toString(8), now: entry.want.toString(8) }, 'modes: tightened a path wider than owner-only');
  }
  return checkModes(config, options);
}
