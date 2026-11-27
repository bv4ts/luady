import { ensureFleetKey } from '../fleet/fleet-key.js';
import { createHostsService, type HostScanner, type KitPayload, type LocalKit, type LookupFn, type RemoteRunner } from '../hosts/index.js';
import type { WireContext, Wired } from './context.js';

/**
 * The hosts module's overrides for demo mode and tests: a fake scanner, kit runner and local kit (and a resolver), so
 * the add-server flow never touches a socket or spawns a process. Declared here, by declaration merging, so `app.ts`
 * needs no edit.
 */
export interface HostsOverrides {
  readonly scanner?: HostScanner;
  readonly remote?: RemoteRunner;
  readonly localKit?: LocalKit;
  readonly lookup?: LookupFn;
  readonly payload?: () => Promise<KitPayload>;
}

declare module '../app.js' {
  interface AppOverrides {
    /** Demo mode and tests: the hosts module's outside dependencies. Never set in production. */
    hosts?: HostsOverrides;
  }
}

/**
 * Hosts: the fleet key first (made on the first start, before the fleet's links start in the `infra` phase), then the
 * hosts service. The website gets the hosts routes (registered because the service is present); `doctor` reads the
 * list through the status route.
 */
export function wireHosts(ctx: WireContext): Wired {
  const { config } = ctx;
  const log = ctx.get('log').child({ mod: 'hosts' });
  const fleetKey = ensureFleetKey(config.fleetKeyPath, log);
  const seams = ctx.overrides.hosts ?? {};
  const hosts = ctx.provide('hosts', createHostsService({
    db: ctx.get('db'), bus: ctx.get('bus'), clock: ctx.get('clock'), log, config, fleet: ctx.get('fleet'), fleetKey,
    pin: ctx.later('pin'),
    actions: () => ctx.get('actions'),
    rooms: () => ctx.get('rooms'),
    signedIn: (id) => ctx.get('claudeLogin').statuses().find((status) => status.host === id)?.loggedIn ?? null,
    ...seams,
  }));
  return {
    name: 'hosts',
    services: { hosts },
    web: { hosts },
    async start(phase) {
      if (phase === 'services') await ctx.start('hosts', () => hosts.start());
    },
    async stop(phase) {
      if (phase === 'services') await ctx.stop('hosts', () => hosts.stop());
    },
  };
}
