import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';
import type { HubConfig } from '../core/contracts.js';
import { hubTokenPath, managerHomeOf } from '../config/defaults.js';
import { MANAGER_DIR } from '../luady/render.js';
import { oldCodexHomes } from '../media/codex.js';

/**
 * The hub's own files and folders on the machine it runs on. "This computer", when it is added as a host, runs its kit
 * as the hub's own user, so a file tool aimed at it could read the hub's secrets: these paths are refused there, to
 * every caller and whatever the PIN. The manager's own folder (brainDir) stays open to it.
 */
export interface HubFolders {
  /**
   * The config folder, the secrets file, the data and run folders (the hub's Codex home inside), the manager's home, the
   * hub token, the fleet key, the manager's rendered settings in its own folder, and the old Codex homes (`~/.codex`
   * and the `.codex` folder beside the data folder).
   */
  readonly hub: readonly string[];
  /** The manager's own folder: open even where it lies inside one of the hub's (a more specific match wins). */
  readonly own: readonly string[];
  /**
   * Refused for writes only: the programs the hub runs here, the local kit (its folder) and the install root (the hub
   * and the manager's MCP server, which runs with the hub token). Reading them is harmless; replacing them is not.
   */
  readonly writeOnly: readonly string[];
}

/** The real path of an existing file or folder, or null (missing, unreadable, or not a POSIX path). */
export type RealPath = (path: string) => string | null;

/** What is done to a path: a read, or a write (which also refuses the hub's programs). */
export type HubPathUse = 'read' | 'write';

export interface HubPathGuard {
  /** Why `path` may not be touched on this computer, or null when it may. */
  refusal(path: string, use?: HubPathUse): string | null;
}

export interface HubPathGuardOptions {
  /** Defaults to the file system's own (symlinks resolved); tests pass their own. */
  readonly realpath?: RealPath;
  /** What `~` means: the hub user's home. */
  readonly home?: string;
  /** The hub user's name, for `~name/…`. */
  readonly user?: string | null;
}

/** At most this many folders up are tried when a path does not exist yet (a file about to be written). */
const REAL_PATH_DEPTH = 64;

/** The local kit's folder: `~/.luady` for its default `~/.luady/bin/luady-ctl`, else the folder of the program itself. */
function kitFolder(ctlPath: string): string {
  const bin = posix.dirname(ctlPath);
  return posix.basename(bin) === 'bin' ? posix.dirname(bin) : bin;
}

export function hubFolders(
  config: Pick<HubConfig, 'dataDir' | 'runDir' | 'brainDir' | 'fleetKeyPath'> & Partial<Pick<HubConfig, 'managerHome' | 'localCtlPath'>>,
  files: { readonly configPath: string; readonly secretsPath: string; readonly installRoot?: string },
): HubFolders {
  return {
    hub: [
      posix.dirname(files.configPath), files.secretsPath, config.dataDir, config.runDir, managerHomeOf(config), hubTokenPath(config),
      config.fleetKeyPath,
      // The manager's settings, MCP config and prompt hook, which the hub renders into its folder (luady/render.ts).
      posix.join(config.brainDir, MANAGER_DIR),
      // Where an older release kept the ChatGPT sign-in for pictures (the user's own ~/.codex, or beside the data
      // folder): its tokens stay live there until it is signed out or deleted.
      ...oldCodexHomes(config.dataDir, '~'),
    ],
    own: [config.brainDir],
    writeOnly: [
      ...(config.localCtlPath === undefined ? [] : [kitFolder(config.localCtlPath)]),
      ...(files.installRoot === undefined ? [] : [files.installRoot]),
    ],
  };
}

export const fsRealPath: RealPath = (path) => {
  try {
    const real = realpathSync.native(path);
    return real.startsWith('/') ? real : null;
  } catch {
    return null;
  }
};

function hubUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

/** `~`, `~/x` and `~<hub user>/x` expanded, then `..`, `.` and repeated slashes resolved; null when not absolute. */
export function normalisePath(path: string, home: string, user: string | null): string | null {
  const slash = path.indexOf('/');
  const head = slash === -1 ? path : path.slice(0, slash);
  const rest = slash === -1 ? '' : path.slice(slash);
  const expanded = head === '~' || (user !== null && head === `~${user}`) ? `${home}${rest}` : path;
  if (!expanded.startsWith('/')) return null;
  const normal = posix.normalize(expanded);
  return normal.length > 1 && normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

/** The real form of an absolute path: the longest existing prefix with its symlinks resolved, the rest kept as written. */
function realForm(path: string, realpath: RealPath): string {
  let head = path;
  let tail = '';
  for (let depth = 0; depth < REAL_PATH_DEPTH; depth += 1) {
    const real = realpath(head);
    if (real !== null) return posix.normalize(`${real}${tail}`);
    if (head === '/') break;
    tail = `/${posix.basename(head)}${tail}`;
    head = posix.dirname(head);
  }
  return path;
}

/** Case is ignored: a folder that differs only in case may be the same one on some file systems. */
const forms = (path: string, realpath: RealPath): string[] => [...new Set([path, realForm(path, realpath)].map((form) => form.toLowerCase()))];

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/** The length of the most specific root that holds `path`, or -1. */
function bestMatch(path: string, roots: readonly string[]): number {
  return roots.reduce((best, root) => (root.length > best && inside(path, root) ? root.length : best), -1);
}

export function createHubPathGuard(folders: HubFolders, options: HubPathGuardOptions = {}): HubPathGuard {
  const realpath = options.realpath ?? fsRealPath;
  const home = options.home ?? homedir();
  const user = options.user === undefined ? hubUser() : options.user;
  const rootsOf = (paths: readonly string[]): string[] =>
    paths.flatMap((path) => {
      const normal = normalisePath(path, home, user);
      return normal === null ? [] : forms(normal, realpath);
    });
  // Read at every call: a folder created after the start (the manager's home on its first switch-on) still counts.
  const roots = (): { hub: string[]; own: string[]; programs: string[] } => ({
    hub: rootsOf(folders.hub), own: rootsOf(folders.own), programs: rootsOf(folders.writeOnly),
  });
  return {
    refusal(path, use = 'read') {
      const normal = normalisePath(path, home, user);
      if (normal === null) return `${path} is not an absolute path; on this computer only absolute paths are used`;
      const { hub, own, programs } = roots();
      const all = forms(normal, realpath);
      // Each form on its own: a link in the manager's folder that leads into the hub's is refused by its real form.
      if (all.some((form) => bestMatch(form, hub) > bestMatch(form, own))) {
        return `${path} belongs to the hub itself (its config, secrets, data, run folder, the manager's home or a ChatGPT sign-in), so no tool may open it on this computer, with or without a PIN`;
      }
      if (use === 'write' && all.some((form) => bestMatch(form, programs) >= 0)) {
        return `${path} is part of the programs the hub runs here (its install or the local kit), so nothing may write it on this computer, with or without a PIN`;
      }
      return null;
    },
  };
}
