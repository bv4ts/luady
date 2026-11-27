import type { HostId } from '@luady/shared';
import type { App } from '../packages/hub/dist/app.js';
import type { Db } from '../packages/hub/dist/core/contracts.js';
import { seedHistory, type PreviewClock } from './history-seed.ts';
import type { PageHook } from './page-hook.ts';
import { seedWave2 } from './seed-wave2.ts';
import type { Wave2Controls } from './wave2-scenarios.ts';

/** The fleet wall's history, the extras seed and the drive verbs' controls in the preview hub. */

const MIN_MS = 60_000;

/** The service parts the fleet history seed calls (they exist on the objects, not on the App's types). */
interface FleetHistoryInternals { sample(): void; readAccounts(): Promise<void> }
interface LimitsInternals { record(host: HostId, reading: unknown, atIso: string): boolean }
interface BoardInternals { checkReminders(): Promise<void> }

/** Before the hub starts: 24 hours of fleet samples and account limits (the wall keeps them in memory only). */
export async function seedFleetHistory(app: App, clock: PreviewClock): Promise<void> {
  const history = app.services.fleetHistory as unknown as FleetHistoryInternals;
  const limits = app.services.limits as unknown as LimitsInternals;
  // The accounts are grouped by sign-in (one card per organisation); read them first, so the history is kept under
  // the same account ids the wall lists afterwards (before the check every host is its own account).
  await app.services.login.check().catch(() => undefined);
  await seedHistory({
    clock,
    sample: () => history.sample(),
    readAccounts: () => history.readAccounts(),
    recordLimits: (host, reading, at) => {
      limits.record(host, reading, at);
    },
  });
}

export function wave2Controls(app: App, hook: PageHook, clock: () => Date): Wave2Controls {
  const board = app.services.board as unknown as BoardInternals;
  const add = async (title: string, patch: { snoozeUntil?: string; dueAt?: string }): Promise<number> => {
    const card = await app.services.board.add({ title, source: 'web' }, 'owner');
    await app.services.board.update(card.id, patch, 'owner');
    return card.id;
  };
  const inMinutes = (minutes: number): string => new Date(clock().getTime() + minutes * MIN_MS).toISOString();
  return {
    away: (minutes) => hook.setAway(minutes),
    clock: (hhmm) => hook.setClock(hhmm),
    remind: () => board.checkReminders(),
    snooze: (minutes, title) => add(title, { snoozeUntil: inMinutes(minutes) }),
    due: (minutes, title) => add(title, { dueAt: inMinutes(minutes) }),
    forgetLimits: (host, at) => app.services.limits.reset(host, at.toISOString()),
  };
}

/** After the cards and notes seed: links, schedules, wins, today and yesterday, reminders (once per database). */
export async function populateWave2(app: App, db: Db, clock: () => Date): Promise<void> {
  await seedWave2({
    db, clock, board: app.services.board, links: app.services.links, scheduler: app.services.scheduler,
  });
}
