import { randomBytes } from 'node:crypto';
import type { HostId } from '@luady/shared';
import type { Clock } from '../core/contracts.js';
import { sha256Hex } from '../core/ids.js';

/** What a terminal ticket opens: a shell on one server, optionally attached to a tmux target. */
export interface TicketGrant {
  server: HostId;
  target?: string;
}

export interface TicketStore {
  /** Issues a ticket bound to the website session that asked for it (`sid`; only its hash is kept). */
  issue(payload: TicketGrant & { sid: string }): string;
  /** The grant, once, and only to the session the ticket was issued to; presented by any other session it is spent. */
  consume(ticket: string, sid: string): TicketGrant | null;
}

interface TicketEntry {
  readonly grant: TicketGrant;
  readonly sidHash: string;
  readonly expiresAt: number;
}

/** Terminal tickets are single use and valid for 60 s (POST /api/terminal/open). */
export const TICKET_TTL_MS = 60_000;
const TICKET_BYTES = 32;
const TICKET_RE = /^[a-f0-9]{64}$/;

function copyGrant(grant: TicketGrant): TicketGrant {
  return grant.target === undefined ? { server: grant.server } : { server: grant.server, target: grant.target };
}

export function createTicketStore(clock: Clock): TicketStore {
  const entries = new Map<string, TicketEntry>();

  function purgeExpired(nowMs: number): void {
    for (const [ticket, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(ticket);
    }
  }

  return {
    issue(payload) {
      if (payload.sid === '') throw new Error('A terminal ticket must be bound to a session');
      const nowMs = clock.now().getTime();
      purgeExpired(nowMs);
      const ticket = randomBytes(TICKET_BYTES).toString('hex');
      entries.set(ticket, { grant: copyGrant(payload), sidHash: sha256Hex(payload.sid), expiresAt: nowMs + TICKET_TTL_MS });
      return ticket;
    },
    consume(ticket, sid) {
      if (!TICKET_RE.test(ticket)) return null;
      const entry = entries.get(ticket);
      entries.delete(ticket);
      if (entry === undefined || clock.now().getTime() >= entry.expiresAt) return null;
      if (sid === '' || sha256Hex(sid) !== entry.sidHash) return null;
      return copyGrant(entry.grant);
    },
  };
}
