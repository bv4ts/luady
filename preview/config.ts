import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { RoomImport, HostId } from '@luady/shared';
import type { HubConfig, ServerConfig } from '../packages/hub/dist/core/contracts.js';
import { PREVIEW_ROOMS } from './rooms-seed.ts';

// Runtime imports from the build stay out of this file on purpose: main.ts loads it before it has checked that the
// build exists (rooms-seed.ts is plain data).

export const PREVIEW_PORT = 7420;
export const PREVIEW_PIN = '123456';
/**
 * The fixed owner zone (stored as owner_tz) of the preview's tests and of a run with `--clock`: not UTC, so zone mistakes
 * show, and the same on every machine, so those runs stay repeatable.
 */
export const PREVIEW_OWNER_TZ = 'Etc/GMT-4';

/** This machine's own zone, as Intl names it (the person running the demo lives in it); UTC when it names none. */
export function machineZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== 'string' || zone === '') return 'UTC';
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * The owner zone `npm run demo` and `npm run preview` store: the machine's own, so the clock and the light follow the
 * person running it; with a fixed `--clock`, the fixed zone, so the same clock shows the same office everywhere.
 */
export function demoOwnerZone(clock: Date | undefined, machine: () => string = machineZone): string {
  return clock === undefined ? machine() : PREVIEW_OWNER_TZ;
}
/** Reserved top-level domain (RFC 2606): no preview host can ever resolve to a real machine. */
export const PREVIEW_DOMAIN = 'preview.invalid';
export const PREVIEW_SERVERS: readonly HostId[] = ['cedar', 'birch', 'ash', 'local'];
/** Where the preview's servers keep their projects (each fake kit's panes start under it). */
export const PREVIEW_PROJECTS_ROOT = '/home/dev/projects';

const FAKE_HOST_KEY = `SHA256:${'A'.repeat(43)}`;

export function previewHost(name: string): string {
  return `${name}.${PREVIEW_DOMAIN}`;
}

/** The browser opens `http`; the hub only accepts its `https` public origin (the origin shim maps one to the other). */
export function previewOrigins(port: number): { readonly http: string; readonly https: string } {
  return { http: `http://localhost:${port}`, https: `https://localhost:${port}` };
}

const randomHex = (): string => randomBytes(32).toString('hex');

function serverConfig(name: HostId): ServerConfig {
  return { name, host: previewHost(name), user: 'dev', port: 22, hostKeyFp: FAKE_HOST_KEY };
}

export interface PreviewConfigOptions {
  dir: string;
  port: number;
  webDir: string;
  /** The rooms imported once into an empty rooms table (default: the classic four). */
  rooms?: readonly RoomImport[];
  /** Servers beyond the four demo ones (`npm run demo -- --rooms mixed`), all under `.invalid`. */
  extraServers?: readonly string[];
}

/**
 * A complete hub config for one preview run, as a new install has it: local sign-in, loopback only, no
 * add-on, plus the four demo servers and their classic rooms. Every secret is new on every call.
 */
export function previewConfig(opts: PreviewConfigOptions): HubConfig {
  return {
    servers: [...PREVIEW_SERVERS, ...(opts.extraServers ?? [])].map(serverConfig),
    fleetKeyPath: join(opts.dir, 'no-key'),
    dataDir: join(opts.dir, 'data'),
    brainDir: join(opts.dir, 'brain'),
    runDir: join(opts.dir, 'run'),
    webDir: opts.webDir,
    webPort: opts.port,
    publicOrigin: previewOrigins(opts.port).https,
    rpId: 'localhost',
    authMode: 'local',
    bindHost: '127.0.0.1',
    allowRemote: false,
    addons: [],
    rooms: [...(opts.rooms ?? PREVIEW_ROOMS)],
    allowedHosts: [new URL(previewOrigins(opts.port).https).host],
    trustedProxy: null,
    ownerLabel: 'owner',
    managerHome: join(opts.dir, 'data', 'manager-home'),
    managerFiles: 'own-folder',
    twilio: null,
    google: null,
    imap: null,
    sessionSecret: randomHex(),
    hubSocketToken: randomHex(),
    claudePath: '/nonexistent/claude',
    localCtlPath: join(opts.dir, 'no-local-luady-ctl'),
    remoteCtlPath: '~/.luady/bin/luady-ctl',
  };
}
