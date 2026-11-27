import { homedir } from 'node:os';
import { isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthMode } from '@luady/shared';
import type { HubConfig } from '../core/contracts.js';

/** Hub paths are POSIX paths (the hub runs on Linux and WSL2); Node accepts them on Windows too, for the tests. */
const join = posix.join;

/**
 * The defaults of every config field, and the readers the rest of the hub uses for the fields `loadConfig` always
 * fills: a config made by it carries them, a partial config built by hand (tests, tools) may not, and both read the
 * same value through these functions.
 */
export const DEFAULT_WEB_PORT = 7410;
/** Where the web and voice servers listen when the config names no `bindHost`. */
export const DEFAULT_BIND_HOST = '127.0.0.1';
export const DEFAULT_OWNER_LABEL = 'owner';
export const DEFAULT_AUTH_MODE: AuthMode = 'local';
export const DEFAULT_MANAGER_FILES = 'own-folder';
export const DEFAULT_REMOTE_CTL_PATH = '~/.luady/bin/luady-ctl';
/** The product's folder name under the XDG folders. */
const PRODUCT_DIR = 'luady';

/** The repository (install) root: this file sits at `packages/hub/{src,dist}/config/`. */
export function installRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

/** An XDG base folder from the environment, or its fallback under the home folder; a relative value is ignored. */
function xdgDir(env: NodeJS.ProcessEnv, name: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME', fallback: string): string {
  const value = env[name]?.trim();
  return value !== undefined && value !== '' && isAbsolute(value) ? value : fallback;
}

export interface DefaultPaths {
  readonly configPath: string;
  readonly secretsPath: string;
  readonly dataDir: string;
  readonly brainDir: string;
  readonly runDir: string;
  readonly webDir: string;
  readonly claudePath: string;
  readonly localCtlPath: string;
}

/** The default files and folders for one user: `~/.config/luady/{config.json,secrets.env}`, `~/.local/share/luady/…`. */
export function defaultPaths(env: NodeJS.ProcessEnv, home: string = homedir(), root: string = installRoot()): DefaultPaths {
  const configDir = join(xdgDir(env, 'XDG_CONFIG_HOME', join(home, '.config')), PRODUCT_DIR);
  const dataHome = join(xdgDir(env, 'XDG_DATA_HOME', join(home, '.local', 'share')), PRODUCT_DIR);
  return {
    configPath: join(configDir, 'config.json'),
    secretsPath: join(configDir, 'secrets.env'),
    dataDir: join(dataHome, 'data'),
    brainDir: join(dataHome, 'brain'),
    runDir: join(dataHome, 'run'),
    webDir: join(root, 'packages', 'web', 'dist'),
    claudePath: join(home, '.local', 'bin', 'claude'),
    localCtlPath: join(home, '.luady', 'bin', 'luady-ctl'),
  };
}

/** `http://localhost:<port>`: the only plain-http origin the hub accepts. */
export function localOrigin(port: number): string {
  return `http://localhost:${port}`;
}

/** The first start's config file: no hosts (the website adds them), loopback only, local sign-in. */
export const STARTER_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  authMode: DEFAULT_AUTH_MODE,
  bindHost: DEFAULT_BIND_HOST,
  webPort: DEFAULT_WEB_PORT,
  allowRemote: false,
});

// ── Readers that also take a partial config (loadConfig fills every one of these fields; tests and tools may not) ──

export function authModeOf(config: { readonly authMode?: AuthMode | undefined }): AuthMode {
  return config.authMode ?? DEFAULT_AUTH_MODE;
}

export function bindHostOf(config: { readonly bindHost?: string | undefined }): string {
  return config.bindHost ?? DEFAULT_BIND_HOST;
}

export function ownerLabelOf(config: { readonly ownerLabel?: string | undefined }): string {
  return config.ownerLabel ?? DEFAULT_OWNER_LABEL;
}

/** `cloudflare` trusts CF-Connecting-IP from a loopback peer only; the default follows the auth mode. */
export function trustedProxyOf(config: Partial<Pick<HubConfig, 'trustedProxy' | 'authMode'>>): 'cloudflare' | null {
  if (config.trustedProxy !== undefined) return config.trustedProxy;
  return authModeOf(config) === 'cloudflare-access' ? 'cloudflare' : null;
}

/** The Host values the hub answers to: the configured list, else the `host[:port]` of the public origin. */
export function allowedHostsOf(config: Pick<HubConfig, 'publicOrigin'> & Partial<Pick<HubConfig, 'allowedHosts'>>): string[] {
  if (config.allowedHosts !== undefined && config.allowedHosts.length > 0) return [...config.allowedHosts];
  return [new URL(config.publicOrigin).host];
}

/** The manager's own home folder: its HOME, its kit, its Claude Code sign-in and its tmux server. */
export function managerHomeOf(config: Pick<HubConfig, 'dataDir'> & Partial<Pick<HubConfig, 'managerHome'>>): string {
  return config.managerHome ?? join(config.dataDir, 'manager-home');
}

/** What the manager's file tools may touch: its own folder (the default), or anything. */
export function managerFilesOf(config: Partial<Pick<HubConfig, 'managerFiles'>>): 'own-folder' | 'any' {
  return config.managerFiles ?? DEFAULT_MANAGER_FILES;
}

/** The self host's luady-ctl: the kit the bootstrap installs under the manager's home. Derived, never configured. */
export function selfCtlPath(managerHome: string): string {
  return join(managerHome, '.luady', 'bin', 'luady-ctl');
}

/** The folder of the manager's own tmux server (`TMUX_TMPDIR`). */
export function managerTmuxDir(managerHome: string): string {
  return join(managerHome, 'tmux');
}

/** The file the MCP server reads the internal socket token from. */
export function hubTokenPath(config: Pick<HubConfig, 'dataDir'>): string {
  return join(config.dataDir, 'hub-token');
}

/** The internal API's Unix socket. */
export function hubSocketPath(config: Pick<HubConfig, 'runDir'>): string {
  return join(config.runDir, 'hub.sock');
}

/** The add-ons' token folder and the owner's outbox. */
export function addonsDir(config: Pick<HubConfig, 'dataDir'>): string {
  return join(config.dataDir, 'addons');
}

export function outboxDir(config: Pick<HubConfig, 'dataDir'>): string {
  return join(config.dataDir, 'outbox');
}

/** The database file and its WAL companions. */
export function databaseFiles(config: Pick<HubConfig, 'dataDir'>): string[] {
  const file = join(config.dataDir, 'hub.db');
  return [file, `${file}-wal`, `${file}-shm`];
}
