import type { RoomDeleteBody } from '@luady/shared';
import type { Db } from '../core/contracts.js';
import { NotFoundError } from '../core/errors.js';
import { RoomConflictError, RoomInvalidError } from './errors.js';
import type { RoomRecord } from './repo.js';

/**
 * What a removed room leaves behind: its links shelf moves to another room (appended in order) or is
 * deleted; its Jira site is re-keyed to another room or disconnected, which deletes the sealed token and needs the PIN.
 * Live sessions, history, board cards, knowledge pages and projects belong to hosts and are untouched.
 */

/** What one removal changed, for the events the service emits. */
export interface CascadeResult {
  readonly removed: readonly string[];
  readonly links: boolean;
  /** The rooms whose Jira changed (the removed one, and the one its site moved to). */
  readonly jira: readonly string[];
}

export interface Cascade {
  /**
   * Plans and runs one room's removal. `verifyPin` is called (and awaited) only when a Jira site would be disconnected;
   * every refusal is raised before anything is written.
   */
  removeRoom(room: RoomRecord, body: RoomDeleteBody, rooms: readonly RoomRecord[], verifyPin: (pin: string | undefined) => Promise<void>): Promise<CascadeResult>;
  /** Deletes rooms with their links and Jira sites, in one transaction (a host's removal; its PIN was checked by the caller). */
  removeAll(rooms: readonly RoomRecord[]): CascadeResult;
}

export function createCascade(db: Db, removeRow: (id: string) => void): Cascade {
  const linkCount = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM links WHERE server = ?');
  const moveLinks = db.prepare('UPDATE links SET server = @to, position = position + @base WHERE server = @from');
  const deleteLinks = db.prepare('DELETE FROM links WHERE server = ?');
  const hasSite = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM jira_sites WHERE server = ?');
  const moveSite = db.prepare('UPDATE jira_sites SET server = @to WHERE server = @from');
  const clearSeen = db.prepare('DELETE FROM jira_seen WHERE server = ?');
  const moveSeen = db.prepare('UPDATE jira_seen SET server = @to WHERE server = @from');
  const deleteSite = db.prepare('DELETE FROM jira_sites WHERE server = ?');

  const links = (id: string): number => linkCount.get(id)?.n ?? 0;
  const site = (id: string): boolean => (hasSite.get(id)?.n ?? 0) > 0;

  function dropRoom(id: string): void {
    removeRow(id);
    deleteLinks.run(id);
    deleteSite.run(id);
    clearSeen.run(id);
  }

  /** The room things move to: the body's `to`, else the host's home room when a project room is removed. */
  function targetOf(room: RoomRecord, body: RoomDeleteBody, rooms: readonly RoomRecord[]): RoomRecord | null {
    if (body.to !== undefined) {
      const named = rooms.find((other) => other.id === body.to);
      if (named === undefined) throw new NotFoundError(`No room ${body.to}`);
      if (named.id === room.id) throw new RoomInvalidError('move_target', 'A room cannot move its things to itself');
      return named;
    }
    if (room.kind !== 'project' || room.host === null) return null;
    return rooms.find((other) => other.id !== room.id && other.kind !== 'project' && other.host === room.host) ?? null;
  }

  return {
    async removeRoom(room, body, rooms, verifyPin) {
      const linkTotal = links(room.id);
      const hasJira = site(room.id);
      const movesSomething = (body.links === 'move' && linkTotal > 0) || (body.jira === 'move' && hasJira);
      const to = movesSomething ? targetOf(room, body, rooms) : null;
      if (movesSomething && to === null) throw new RoomInvalidError('move_target', 'Say which room its links and Jira move to');
      if (body.jira === 'move' && hasJira && to !== null && site(to.id)) {
        throw new RoomConflictError('jira_exists', `${to.name} already has a Jira site; disconnect one of them first`);
      }
      if (body.jira === 'disconnect' && hasJira) await verifyPin(body.pin);
      db.transaction(() => {
        if (body.links === 'move' && to !== null) moveLinks.run({ from: room.id, to: to.id, base: links(to.id) });
        if (body.jira === 'move' && hasJira && to !== null) {
          clearSeen.run(to.id);
          moveSite.run({ from: room.id, to: to.id });
          moveSeen.run({ from: room.id, to: to.id });
        }
        dropRoom(room.id);
      })();
      const jira = !hasJira ? [] : body.jira === 'move' && to !== null ? [room.id, to.id] : [room.id];
      return { removed: [room.id], links: linkTotal > 0, jira };
    },
    removeAll(rooms) {
      const withLinks = rooms.filter((room) => links(room.id) > 0).length > 0;
      const withJira = rooms.filter((room) => site(room.id)).map((room) => room.id);
      db.transaction(() => {
        for (const room of rooms) dropRoom(room.id);
      })();
      return { removed: rooms.map((room) => room.id), links: withLinks, jira: withJira };
    },
  };
}
