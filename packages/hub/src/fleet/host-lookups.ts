import { LOCAL_HOST_ID, SELF_HOST_ID, isSelfHost, type HostId } from '@luady/shared';
import type { Fleet, FleetHostInfo } from '../core/contracts.js';

/** One host the lookups know: an SSH server, or the local host ("this computer", id `computer`). */
export interface KnownHost {
  readonly name: HostId;
  readonly kind?: 'ssh' | 'local';
  readonly projectsRoot?: string | null;
  readonly homeDir?: string | null;
}

export type HostLookups = Pick<Fleet, 'hosts' | 'hasServer' | 'hasLocal' | 'hasHost' | 'hostInfo'>;

/**
 * The fleet's host lookups, read from `known()` at every call so a host list is never captured: `hasServer` is an SSH
 * host, `hasLocal` the local host, `hasHost` either or the self host.
 */
export function createHostLookups(known: () => readonly KnownHost[]): HostLookups {
  const find = (id: string): KnownHost | undefined => known().find((host) => host.name === id);
  const kindOf = (host: KnownHost): 'ssh' | 'local' => host.kind ?? (host.name === LOCAL_HOST_ID ? 'local' : 'ssh');
  const hasServer = (id: string): boolean => {
    const host = find(id);
    return host !== undefined && kindOf(host) === 'ssh';
  };
  const hasLocal = (id: string): boolean => {
    const host = find(id);
    return host !== undefined && kindOf(host) === 'local';
  };
  return {
    hosts: () => [...known().map((host) => host.name), SELF_HOST_ID],
    hasServer,
    hasLocal,
    hasHost: (id) => isSelfHost(id) || hasServer(id) || hasLocal(id),
    hostInfo(id): FleetHostInfo | null {
      if (isSelfHost(id)) return { id, kind: 'self', projectsRoot: null, homeDir: null, terminal: false };
      const host = find(id);
      if (host === undefined) return null;
      const kind = kindOf(host);
      // Each host's own folders, or none: there is no shared default folder.
      return { id, kind, projectsRoot: host.projectsRoot ?? null, homeDir: host.homeDir ?? null, terminal: kind === 'ssh' };
    },
  };
}
