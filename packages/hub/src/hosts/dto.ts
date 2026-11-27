import type { HostDTO } from '@luady/shared';
import type { LinkError, LinkStatus } from '../fleet/executor.js';
import type { HostRow } from './repo.js';

/** What the live side adds to a row: the link and its last error (the fleet), and what a check or a job learned. */
export interface HostLive {
  link(id: string): LinkStatus | null;
  lastError(id: string): LinkError | null;
  kitAlias(id: string): string | null;
  /** A kit change this run made (`null` after an uninstall), over the row's stored version. */
  kitVersion(id: string): string | null | undefined;
  claudeSignedIn(id: string): boolean | null;
}

/** HostDTO. It never carries key material, a grant or anything a server printed raw. */
export function toHostDto(row: HostRow, live: HostLive): HostDTO {
  const kitOverride = live.kitVersion(row.id);
  return {
    id: row.id, kind: row.kind, host: row.host, user: row.user, port: row.port, source: row.source, state: row.state,
    fingerprint: row.fingerprint,
    link: row.state === 'pinned' ? live.link(row.id) : null,
    lastError: row.state === 'pinned' ? live.lastError(row.id) : null,
    kitVersion: kitOverride === undefined ? row.kitVersion : kitOverride,
    kitAlias: live.kitAlias(row.id),
    claudeVersion: row.claudeVersion,
    claudeSignedIn: live.claudeSignedIn(row.id),
    projectsRoot: row.projectsRoot, homeDir: row.homeDir,
    terminal: row.kind === 'ssh',
    fromAddr: row.fromAddr,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
