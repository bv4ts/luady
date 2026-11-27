import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { LOCAL_HOST_ID } from '@luady/shared';
import type { KitPayload, KitSummaryLite, LocalKit, RemoteRunner } from '../packages/hub/dist/hosts/index.js';
import type { HostsOverrides } from '../packages/hub/dist/wire/hosts.js';
import { KIT_VERSION } from './fake-kit.ts';

/**
 * The demo's outside world for the hosts module: a host-key scanner, a kit runner, this
 * computer's kit, a resolver and the kit payload, all fakes. The preview passes them to the hub every time it runs
 * (`AppOverrides.hosts`), so adding, checking, installing on and removing a server never opens a socket and never
 * starts a process. Only hosts under `.invalid` exist here; anything else is "not found".
 */
export type DemoHostSeams = Required<HostsOverrides>;
type DemoKitSummary = KitSummaryLite;
type DemoFolders = LocalKit['folders'];

/** What the demo's servers look like from inside: a normal user with Python, tmux and Claude Code. */
export const DEMO_SERVER_HOME = '/home/dev';
export const DEMO_SERVER_USER = 'dev';
/** "This computer" in the demo: a home folder that exists only in memory. */
export const DEMO_LOCAL_HOME = '/home/demo';
export const DEMO_LOCAL_USER = 'demo';
const DEMO_CLAUDE = `${DEMO_SERVER_HOME}/.local/bin/claude`;
const CLAUDE_VERSION_LINE = `${KIT_VERSION.claude} (Claude Code)`;
const PYTHON = '3.12';
const TMUX = `tmux ${KIT_VERSION.tmux}`;
/** TEST-NET-1 (RFC 5737): documentation addresses, never a real machine. */
const TEST_NET = '192.0.2';
/** The reserved top-level domain (RFC 2606) every demo host is under. */
const INVALID_TLD = '.invalid';

const sha256 = (text: string | Buffer): Buffer => createHash('sha256').update(text).digest();

/** A host's demo host key: the same name and port always give the same fingerprint. */
export function demoFingerprint(host: string, port: number): string {
  return `SHA256:${sha256(`luady-demo-host-key ${host}:${port}`).toString('base64').replace(/=+$/, '')}`;
}

/** Only names under the reserved `.invalid` domain resolve, each to its own TEST-NET-1 address. */
export function demoAddress(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (!name.endsWith(INVALID_TLD) || name.length === INVALID_TLD.length) return null;
  return `${TEST_NET}.${1 + ((sha256(name)[0] ?? 0) % 250)}`;
}

function notFound(host: string): Error {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (the demo reaches only hosts under .invalid)`), { code: 'ENOTFOUND' });
}

/** The value after a flag in the kit's arguments (`--host-alias <id>`). */
function flagValue(args: readonly string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1] ?? null;
}

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The kit's installer lines, as the real one prints them while it works. */
async function installerLines(onLine: (line: string) => void, lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    await pause();
    onLine(line);
  }
}

function createRemote(): RemoteRunner {
  /** Kit alias per demo server, once installed there. */
  const installed = new Map<string, string>();
  const keyed = new Set<string>();
  return {
    async preflight(host, args) {
      const alias = installed.get(host);
      return [
        'os=Linux', `home=${DEMO_SERVER_HOME}`, `user=${DEMO_SERVER_USER}`, `python=${PYTHON}`, `tmux=${TMUX}`, 'tar=yes', 'mktemp=yes',
        `claude=${args.claudeBin ?? DEMO_CLAUDE}`, `claude_version=${CLAUDE_VERSION_LINE}`, 'projects=yes',
        `kit_alias=${alias === undefined ? '' : `"host_alias": "${alias}"`}`,
        `kit_version=${alias === undefined ? '' : `__version__ = "${KIT_VERSION.kit}"`}`,
      ].join('\n').concat('\n');
    },
    async kit(host, args, _payload, onLine) {
      keyed.add(host);
      if (args.includes('--uninstall')) {
        await installerLines(onLine, ['removing the Luady hooks from ~/.claude/settings.json', 'kept your other hooks']);
        installed.delete(host);
        return { code: 0, summary: { ok: true, action: 'uninstall', settings: `${DEMO_SERVER_HOME}/.claude/settings.json` }, error: null };
      }
      const alias = flagValue(args, '--host-alias') ?? host;
      await installerLines(onLine, ['unpacking the kit', 'installing ~/.luady (hooks, luady-ctl, luady-report)', 'adding the hooks to ~/.claude/settings.json']);
      installed.set(host, alias);
      return {
        code: 0,
        summary: { ok: true, action: 'install', version: KIT_VERSION.kit, host_alias: alias, settings: `${DEMO_SERVER_HOME}/.claude/settings.json`, steps: 'hooks, status line, luady-ctl' },
        error: null,
      };
    },
    async removeKey(host) {
      if (!keyed.has(host) && !installed.has(host)) return 'absent';
      keyed.delete(host);
      return 'removed';
    },
  };
}

function createFolders(): DemoFolders {
  const dirs = new Set<string>(['/', '/home', DEMO_LOCAL_HOME]);
  const normal = (path: string): string => posix.normalize(path).replace(/(.)\/$/, '$1');
  return {
    kind: (path) => (dirs.has(normal(path)) ? 'dir' : null),
    realpath(path) {
      const at = normal(path);
      if (!dirs.has(at)) throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${at}'`), { code: 'ENOENT' });
      return at;
    },
    mkdir(path, _mode) {
      const at = normal(path);
      if (!dirs.has(posix.dirname(at))) throw Object.assign(new Error(`ENOENT: no such file or directory, mkdir '${at}'`), { code: 'ENOENT' });
      dirs.add(at);
    },
  };
}

function createLocalKit(): LocalKit {
  let installed = false;
  return {
    home: () => DEMO_LOCAL_HOME,
    user: () => DEMO_LOCAL_USER,
    platform: () => 'linux',
    folders: createFolders(),
    preflight: async () => ({ python: `${PYTHON}.3`, tmux: TMUX, claude: CLAUDE_VERSION_LINE, missing: [] }),
    installedAlias: async () => (installed ? LOCAL_HOST_ID : null),
    installedVersion: async () => (installed ? KIT_VERSION.kit : null),
    async install(_opts, onLine) {
      await installerLines(onLine, ['installing ~/.luady (hooks, luady-ctl, luady-report)', 'adding the hooks to ~/.claude/settings.json']);
      installed = true;
      return { ok: true, action: 'install', version: KIT_VERSION.kit, host_alias: LOCAL_HOST_ID, settings: `${DEMO_LOCAL_HOME}/.claude/settings.json` };
    },
    async uninstall(onLine) {
      await installerLines(onLine, ['removing the Luady hooks from ~/.claude/settings.json']);
      installed = false;
      return { ok: true, action: 'uninstall', settings: `${DEMO_LOCAL_HOME}/.claude/settings.json` };
    },
  };
}

const PAYLOAD_TEXT = 'luady demo kit: nothing is unpacked anywhere\n';

/** A new set of demo seams (one per preview run): each keeps what was installed where. */
export function createDemoHostSeams(): DemoHostSeams {
  const bytes = Buffer.from(PAYLOAD_TEXT, 'utf8');
  return {
    scanner: { scan: async (target) => ({ fingerprint: demoFingerprint(target.host, target.port), keyType: 'ssh-ed25519' }) },
    remote: createRemote(),
    localKit: createLocalKit(),
    async lookup(host) {
      const address = demoAddress(host);
      if (address === null) throw notFound(host);
      return [{ address, family: 4 }];
    },
    payload: async (): Promise<KitPayload> => ({ bytes, sha256: sha256(bytes).toString('hex'), files: 1 }),
  };
}
