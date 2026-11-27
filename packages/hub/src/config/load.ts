import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { z } from 'zod';
import { isHostId, isNewHostId } from '@luady/shared';
import type { HubConfig } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import {
  DEFAULT_AUTH_MODE, DEFAULT_BIND_HOST, DEFAULT_MANAGER_FILES, DEFAULT_OWNER_LABEL, DEFAULT_REMOTE_CTL_PATH, DEFAULT_WEB_PORT,
  STARTER_CONFIG, defaultPaths, installRoot, localOrigin,
} from './defaults.js';
import { parseEnvFile } from './env-file.js';
import { FILE_MODE, createFileExclusive, ensureDir } from './files.js';
import { accessIncomplete, hostIds, remoteNotAllowed, remoteNotHttps } from './refusals.js';
import { remoteReason } from './remote.js';
import { ConfigFileSchema, SecretsSchema, googleFromSecrets, imapFromSecrets, twilioFromSecrets, type ConfigFile } from './schema.js';
import { ensureSecrets, type GeneratedSecret } from './secrets-gen.js';

const { dirname, join } = posix;

type PathVariable = 'LUADY_CONFIG' | 'LUADY_SECRETS';

export interface LoadOptions {
  /** The home folder the defaults are under; `os.homedir()` when absent (tests pass a temporary folder). */
  home?: string;
  /** The install (repository) root, for the default `webDir`. */
  root?: string;
  /** Told what the first start created (never a value). */
  onCreated?: (what: { readonly config: string | null; readonly secrets: readonly GeneratedSecret[] }) => void;
}

export interface ConfigPaths {
  readonly configPath: string;
  readonly secretsPath: string;
  /** False when LUADY_CONFIG names the file: a missing file is then an error, never a new install. */
  readonly configIsDefault: boolean;
  readonly secretsIsDefault: boolean;
}

function envPath(env: NodeJS.ProcessEnv, name: PathVariable): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * Where the config and the secrets live: LUADY_CONFIG and LUADY_SECRETS when set, else `~/.config/luady/config.json`
 * and `secrets.env` beside the config file (`doctor` reads the same paths).
 */
export function configPaths(env: NodeJS.ProcessEnv, home: string = homedir()): ConfigPaths {
  const configured = envPath(env, 'LUADY_CONFIG');
  const configPath = configured ?? defaultPaths(env, home).configPath;
  const secrets = envPath(env, 'LUADY_SECRETS');
  return {
    configPath,
    secretsPath: secrets ?? join(dirname(configPath), 'secrets.env'),
    configIsDefault: configured === null,
    secretsIsDefault: secrets === null,
  };
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new ValidationError(`cannot read ${what} file ${path}: ${code}`);
  }
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError(`config ${path} is not valid JSON`);
  }
}

/** zod issues → "path: message" list. zod messages never contain the rejected value. */
function validate<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new ValidationError(`invalid ${what}: ${details}`);
}

/** The starter config, written only at the default path and only when no file is there. */
function writeStarter(path: string): boolean {
  ensureDir(dirname(path));
  return createFileExclusive(path, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, FILE_MODE);
}

function readConfigFile(paths: ConfigPaths): { text: string; created: boolean } {
  if (paths.configIsDefault) {
    const created = writeStarter(paths.configPath);
    return { text: readText(paths.configPath, 'config'), created };
  }
  return { text: readText(paths.configPath, 'LUADY_CONFIG'), created: false };
}

function readSecretsFile(paths: ConfigPaths): { text: string; generated: readonly GeneratedSecret[] } {
  if (paths.secretsIsDefault) {
    ensureDir(dirname(paths.secretsPath));
    const { generated } = ensureSecrets(paths.secretsPath);
    return { text: readText(paths.secretsPath, 'secrets'), generated };
  }
  // An explicit LUADY_SECRETS must exist (a wrong path never becomes a fresh secret); missing names are still added.
  readText(paths.secretsPath, 'LUADY_SECRETS');
  const { generated } = ensureSecrets(paths.secretsPath);
  return { text: readText(paths.secretsPath, 'LUADY_SECRETS'), generated };
}

/**
 * Refuses a config where two hosts share an id or a host uses a reserved id. Read from the raw file, before the schema
 * (which refuses a reserved id too), so that it prints the refusal's one line.
 */
function checkHostIds(raw: unknown): void {
  const servers = typeof raw === 'object' && raw !== null ? (raw as { servers?: unknown }).servers : undefined;
  if (!Array.isArray(servers)) return;
  const names = servers.flatMap((entry: unknown) => {
    const name = typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? [name] : [];
  });
  const reserved = names.find((name) => isHostId(name) && !isNewHostId(name));
  if (reserved !== undefined) throw hostIds(`the host id "${reserved}" is reserved`);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw hostIds(`two hosts share the id "${duplicate}"`);
}

/** Every field with its default. */
function withDefaults(file: ConfigFile, env: NodeJS.ProcessEnv, home: string, root: string): Omit<HubConfig, SecretFields> {
  const paths = defaultPaths(env, home, root);
  const webPort = file.webPort ?? DEFAULT_WEB_PORT;
  const publicOrigin = file.publicOrigin ?? localOrigin(webPort);
  const authMode = file.authMode ?? DEFAULT_AUTH_MODE;
  const dataDir = file.dataDir ?? paths.dataDir;
  return {
    ...file,
    servers: (file.servers ?? []).map((server) => ({ ...server })),
    dataDir,
    brainDir: file.brainDir ?? paths.brainDir,
    runDir: file.runDir ?? paths.runDir,
    webDir: file.webDir ?? paths.webDir,
    fleetKeyPath: file.fleetKeyPath ?? join(dataDir, 'fleet_ed25519'),
    managerHome: file.managerHome ?? join(dataDir, 'manager-home'),
    managerFiles: file.managerFiles ?? DEFAULT_MANAGER_FILES,
    addons: file.addons ?? [],
    webPort,
    bindHost: file.bindHost ?? DEFAULT_BIND_HOST,
    allowRemote: file.allowRemote ?? false,
    publicOrigin,
    // The default RP ID is the origin's host: `localhost` for the default origin.
    rpId: file.rpId ?? new URL(publicOrigin).hostname,
    allowedHosts: file.allowedHosts ?? [new URL(publicOrigin).host],
    trustedProxy: file.trustedProxy !== undefined ? file.trustedProxy : authMode === 'cloudflare-access' ? 'cloudflare' : null,
    authMode,
    ownerLabel: file.ownerLabel ?? DEFAULT_OWNER_LABEL,
    claudePath: file.claudePath ?? paths.claudePath,
    localCtlPath: file.localCtlPath ?? paths.localCtlPath,
    remoteCtlPath: file.remoteCtlPath ?? DEFAULT_REMOTE_CTL_PATH,
  };
}

type SecretFields = 'cfAccessAud' | 'sessionSecret' | 'hubSocketToken' | 'twilio' | 'google' | 'imap';

/**
 * The startup refusals that need only the config: a remote install that is not allowed or not on https, and an
 * incomplete Access install. The others need the database or the file system (main.ts).
 */
export function assertStartable(config: HubConfig): void {
  const remote = remoteReason(config);
  if (remote !== null && config.allowRemote !== true) throw remoteNotAllowed(remote);
  if (remote !== null && new URL(config.publicOrigin).protocol !== 'https:') throw remoteNotHttps();
  if (config.authMode === 'cloudflare-access') {
    const missing = [
      config.cfTeamDomain === undefined ? 'cfTeamDomain' : null,
      config.ownerEmail === undefined ? 'ownerEmail' : null,
      config.cfAccessAud === undefined ? 'CF_ACCESS_AUD' : null,
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) throw accessIncomplete(missing);
  }
}

/**
 * Reads config.json and secrets.env, filling every default and applying the startup refusals that need only the config.
 * With LUADY_CONFIG unset it uses `~/.config/luady/config.json`, writing a starter file (0600, folder 0700) when there
 * is none; the two hub secrets are generated once, at 0600, and never overwritten.
 */
export function loadConfig(env: NodeJS.ProcessEnv, options: LoadOptions = {}): HubConfig {
  const home = options.home ?? homedir();
  const paths = configPaths(env, home);
  const config = readConfigFile(paths);
  const raw = parseJson(config.text, paths.configPath);
  checkHostIds(raw);
  const file = validate(ConfigFileSchema, raw, `config ${paths.configPath}`);
  // An Access install that names no mode would silently stop checking Access: it must say which mode it is.
  if (file.authMode === undefined && file.cfTeamDomain !== undefined) {
    throw new ValidationError(`invalid config ${paths.configPath}: authMode: cfTeamDomain is set, so say "authMode": "cloudflare-access" (or remove cfTeamDomain for local mode)`);
  }
  const secretsFile = readSecretsFile(paths);
  options.onCreated?.({ config: config.created ? paths.configPath : null, secrets: secretsFile.generated });
  const secrets = validate(SecretsSchema, parseEnvFile(secretsFile.text), `secrets ${paths.secretsPath}`);
  const resolved: HubConfig = {
    ...withDefaults(file, env, home, options.root ?? installRoot()),
    ...(secrets.CF_ACCESS_AUD === undefined ? {} : { cfAccessAud: secrets.CF_ACCESS_AUD }),
    sessionSecret: secrets.SESSION_SECRET,
    hubSocketToken: secrets.HUB_SOCKET_TOKEN,
    twilio: twilioFromSecrets(secrets),
    google: googleFromSecrets(secrets),
    imap: imapFromSecrets(secrets),
  };
  assertStartable(resolved);
  return resolved;
}
