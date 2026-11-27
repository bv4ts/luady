import type { Fleet } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { createFleet, type DynamicFleet } from '../fleet/fleet.js';
import type { WireContext, Wired } from './context.js';

/**
 * A fleet passed in by a test or the preview (AppOverrides.fleet, a plain Fleet), as the dynamic fleet: every call goes
 * to it, its own run-time methods when it has them; without them a host change is refused and no host has a link.
 */
function asDynamic(fleet: Fleet): DynamicFleet {
  const own = fleet as Fleet & Partial<DynamicFleet>;
  const refuse = (): never => {
    throw new RefusedError('This fleet cannot change its hosts while the hub runs');
  };
  return {
    start: () => fleet.start(), stop: () => fleet.stop(), client: (host) => fleet.client(host), servers: () => fleet.servers(),
    openShell: (server, opts) => fleet.openShell(server, opts), tailEvents: (host, from, onLine) => fleet.tailEvents(host, from, onLine),
    hosts: () => fleet.hosts(), hasServer: (id) => fleet.hasServer(id), hasLocal: (id) => fleet.hasLocal(id), hasHost: (id) => fleet.hasHost(id),
    hostInfo: (id) => fleet.hostInfo(id),
    addHost: (id) => (own.addHost === undefined ? refuse() : own.addHost(id)),
    replaceHost: async (id) => (own.replaceHost === undefined ? refuse() : own.replaceHost(id)),
    removeHost: async (id) => (own.removeHost === undefined ? refuse() : own.removeHost(id)),
    link: (id) => own.link?.(id) ?? null,
    executor: (id) => own.executor?.(id),
    lastSync: () => own.lastSync?.() ?? null,
  };
}

/**
 * Whether the self host may be reached: only while the manager switch is on and its bootstrap is done. Read at call
 * time: wire/manager.ts provides the switch after the fleet is built.
 */
function managerReady(ctx: WireContext): boolean {
  return ctx.get('managerControl').ready();
}

/**
 * Fleet: the dynamic fleet (executors for pinned rows, changed at run time by the hosts module), its host lists as
 * functions (Fleet.hosts and the membership checks), and the self host behind the manager switch. It is the `infra`
 * phase: started first, stopped after every service.
 */
export function wireFleet(ctx: WireContext): Wired {
  const given = ctx.overrides.fleet;
  const fleet = ctx.provide('fleet', given !== undefined ? asDynamic(given) : createFleet({
    config: ctx.config, db: ctx.get('db'), bus: ctx.get('bus'), clock: ctx.get('clock'), log: ctx.get('log'),
    selfReady: () => managerReady(ctx),
    selfListed: () => ctx.get('settings').get().manager_enabled,
  }));
  return {
    name: 'fleet',
    services: { fleet },
    web: { fleet },
    tools: { fleet },
    async start(phase) {
      if (phase === 'infra') await ctx.start('fleet', () => fleet.start());
    },
    async stop(phase) {
      if (phase === 'infra') await ctx.stop('fleet', () => fleet.stop());
    },
  };
}
