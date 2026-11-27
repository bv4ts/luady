import type { FastifyPluginAsync } from 'fastify';
import { INTERNAL_PATHS, type ChannelInfoDTO, type HostDTO } from '@luady/shared';
import { authModeOf } from '../config/defaults.js';
import { configPaths } from '../config/load.js';
import { checkModes, type ModeEntry } from '../config/modes.js';
import { isRemote } from '../config/remote.js';
import type { Clock } from '../core/contracts.js';
import type { BootstrapReport } from '../luady/bootstrap.js';
import type { ManagerState } from '../luady/control.js';
import type { ManagerStatusState } from '../luady/service.js';
import type { WireContext, Wired } from './context.js';

/** One host as `doctor` sees it: its link, kit, alias and last error (a subset of HostDTO). */
export interface HostStatus {
  readonly id: string;
  readonly kind: 'ssh' | 'local';
  readonly link: 'online' | 'offline' | 'connecting' | null;
  readonly kitVersion: string | null;
  readonly kitAlias: string | null;
  readonly claudeVersion: string | null;
  readonly lastError: 'auth' | 'network' | 'hostkey' | null;
}

/** `GET /internal/status`. Never holds a secret, a token, a setup code or a page key. */
export interface HubStatus {
  readonly at: string;
  readonly authMode: 'local' | 'cloudflare-access';
  readonly remote: boolean;
  readonly manager: {
    /** The switch: off, starting (bootstrapping), on, failed. */
    readonly switch: ManagerState;
    /** The manager itself: off, or the supervisor's state. */
    readonly state: ManagerStatusState;
    /** The bootstrap's steps (each "manager off" while the switch is off), and the self host's kit: path, version, alias. */
    readonly bootstrap: BootstrapReport;
  };
  readonly hosts: readonly HostStatus[];
  /** The config sync of this start: file entries skipped for a website host's id, and config hosts now removed. */
  readonly configSync: { readonly collisions: readonly string[]; readonly removed: readonly string[] } | null;
  readonly addons: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly state: string; readonly connected: boolean }>;
  /** The owned folders and files (config/modes.ts checkModes): mode, owner, state. */
  readonly modes: readonly ModeEntry[];
}

function fromHostDto(host: HostDTO): HostStatus {
  return {
    id: host.id, kind: host.kind, link: host.link, kitVersion: host.kitVersion, kitAlias: host.kitAlias, claudeVersion: host.claudeVersion,
    lastError: host.lastError,
  };
}

function addonOf(channel: ChannelInfoDTO): HubStatus['addons'][number] {
  return { id: channel.id, kind: channel.kind, state: channel.state, connected: channel.state === 'up' };
}

export function buildStatus(ctx: WireContext, clock: Clock, env: NodeJS.ProcessEnv = process.env): HubStatus {
  const { config } = ctx;
  const control = ctx.get('managerControl');
  const luady = ctx.get('luady');
  const fleet = ctx.get('fleet');
  const hosts = ctx.get('hosts').list().map(fromHostDto);
  const sync = fleet.lastSync();
  return {
    at: clock.now().toISOString(),
    authMode: authModeOf(config),
    remote: isRemote(config),
    manager: { switch: control.state(), state: control.ready() ? luady.status().state : 'off', bootstrap: control.bootstrap() },
    hosts,
    configSync: sync === null ? null : { collisions: sync.collisions, removed: sync.removed },
    addons: ctx.get('channels').list().map(addonOf),
    modes: checkModes(config, { secretsPath: configPaths(env).secretsPath }),
  };
}

/** The internal status route (`doctor` reads it over the hub socket, behind the hub token). */
function statusRoute(ctx: WireContext): FastifyPluginAsync {
  return async (app) => {
    app.get(INTERNAL_PATHS.status, async () => buildStatus(ctx, ctx.get('clock')));
  };
}

/**
 * Status: `GET /internal/status` for `doctor`, contributed as an `internal` route plugin, so it sits behind the hub
 * token like every internal route.
 */
export function wireStatus(ctx: WireContext): Wired {
  return { name: 'status', services: {}, internal: [statusRoute(ctx)] };
}
