import type { AccountDTO, LinkDTO, HostId, WinDTO } from '@luady/shared';
import { ownerMs } from '../../../../src/features/agency/drawers/schedule/owner-time.js';

/** Fixtures for the fleet, wins, timeline, schedule and links pop-ups. Times are fixed owner wall times on Sunday 15 Nov 2026. */
export const NOW = ownerMs(2026, 11, 15, 14, 30);
export const iso = (ms: number): string => new Date(ms).toISOString();

export function account(over: Partial<AccountDTO> = {}): AccountDTO {
  return {
    id: 'claude:org-1', provider: 'claude', email: 'owner@example.com', orgName: null, plan: 'max', isManager: false,
    hosts: [{ host: 'birch', loggedIn: true, expiresAt: null, checkedAt: null, loginPending: false, canLogout: true }],
    limits: {
      reported: 'yes', updatedAt: iso(NOW),
      fiveHour: { usedPct: 62, resetsAt: iso(ownerMs(2026, 11, 15, 17)) },
      sevenDay: null,
    },
    ...over,
  } as AccountDTO;
}

export function win(id: number, doneAt: number, over: Partial<WinDTO> = {}): WinDTO {
  return { id, title: `Win ${String(id)}`, project: 'orchard-web', server: 'birch', result: 'Shipped.', links: [], doneAt: iso(doneAt), ...over };
}

export function link(id: number, server: HostId, position: number, over: Partial<LinkDTO> = {}): LinkDTO {
  return { id, server, label: `Link ${String(id)}`, url: `https://example${String(id)}.com/`, position, ...over };
}
