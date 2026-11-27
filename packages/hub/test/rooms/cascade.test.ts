import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../src/core/errors.js';
import { insertJira, insertLink, jiraRooms, linksOf, projectRoom, rig, serverRoom, tombstone } from './helpers.js';

const noPin = async (): Promise<void> => undefined;

function threeRooms() {
  const r = rig();
  r.rooms.create(serverRoom('birch', 'Orchard'));
  r.rooms.create(projectRoom('Shop', 'shop*', { host: 'birch', id: 'shop' }));
  r.rooms.create(serverRoom('ash', 'Harbor'));
  return r;
}

describe('removing a room: its links', () => {
  it('moves the links to the named room, appended in order', async () => {
    const { rooms, db, events } = threeRooms();
    insertLink(db, 'harbor', 'h0', 0);
    insertLink(db, 'shop', 's0', 0);
    insertLink(db, 'shop', 's1', 1);
    await rooms.remove('shop', { links: 'move', jira: 'disconnect', to: 'harbor' }, noPin);
    expect(linksOf(db, 'harbor')).toEqual(['h0', 's0', 's1']);
    expect(linksOf(db, 'shop')).toEqual([]);
    expect(events.map((event) => event.name)).toContain('links.changed');
  });

  it('moves them to the host\'s home room when no room is named, and deletes them on request', async () => {
    const { rooms, db } = threeRooms();
    insertLink(db, 'shop', 's0', 0);
    await rooms.remove('shop', { links: 'move', jira: 'disconnect' }, noPin);
    expect(linksOf(db, 'orchard')).toEqual(['s0']);
    insertLink(db, 'harbor', 'h0', 0);
    await rooms.remove('harbor', { links: 'delete', jira: 'disconnect' }, noPin);
    expect(linksOf(db, 'harbor')).toEqual([]);
  });

  it('refuses a move with nowhere to go, to itself, or to an unknown room, and writes nothing', async () => {
    const { rooms, db } = threeRooms();
    insertLink(db, 'harbor', 'h0', 0);
    await expect(rooms.remove('harbor', { links: 'move', jira: 'disconnect' }, noPin)).rejects.toMatchObject({ code: 'move_target' });
    await expect(rooms.remove('harbor', { links: 'move', jira: 'disconnect', to: 'harbor' }, noPin)).rejects.toMatchObject({ code: 'move_target' });
    await expect(rooms.remove('harbor', { links: 'move', jira: 'disconnect', to: 'nowhere' }, noPin)).rejects.toBeInstanceOf(NotFoundError);
    expect(linksOf(db, 'harbor')).toEqual(['h0']);
    expect(rooms.get('harbor')).not.toBeNull();
  });
});

describe('removing a room: its Jira site', () => {
  it('moves the site (re-keyed with its seen marks) to a room without one', async () => {
    const { rooms, db, events } = threeRooms();
    insertJira(db, 'shop');
    await rooms.remove('shop', { links: 'delete', jira: 'move', to: 'harbor' }, noPin);
    expect(jiraRooms(db)).toEqual(['harbor']);
    expect(db.prepare("SELECT server FROM jira_seen").all()).toEqual([{ server: 'harbor' }]);
    const jira = events.filter((event) => event.name === 'jira.changed').map((event) => (event.payload as { room: string }).room);
    expect(jira).toEqual(['shop', 'harbor']);
    expect(events.map((event) => event.name)).toContain('accounts.changed');
  });

  it('refuses to move it onto a room that has a site (409 jira_exists), writing nothing', async () => {
    const { rooms, db } = threeRooms();
    insertJira(db, 'shop');
    insertJira(db, 'harbor');
    await expect(rooms.remove('shop', { links: 'delete', jira: 'move', to: 'harbor' }, noPin)).rejects.toMatchObject({ code: 'jira_exists' });
    expect(jiraRooms(db)).toEqual(['harbor', 'shop']);
    expect(rooms.get('shop')).not.toBeNull();
  });

  it('disconnects it only after the PIN: the check runs, and a refused PIN deletes nothing', async () => {
    const { rooms, db } = threeRooms();
    insertJira(db, 'shop');
    const refuse = vi.fn(async () => {
      throw new Error('PIN required');
    });
    await expect(rooms.remove('shop', { links: 'delete', jira: 'disconnect' }, refuse)).rejects.toThrow('PIN required');
    expect(refuse).toHaveBeenCalledWith(undefined);
    expect(jiraRooms(db)).toEqual(['shop']);
    const accept = vi.fn(async () => undefined);
    await rooms.remove('shop', { links: 'delete', jira: 'disconnect', pin: '123456' }, accept);
    expect(accept).toHaveBeenCalledWith('123456');
    expect(jiraRooms(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM jira_seen').get()).toEqual({ n: 0 });
  });

  it('asks for no PIN when the room has no site', async () => {
    const { rooms } = threeRooms();
    const pin = vi.fn(noPin);
    await rooms.remove('harbor', { links: 'delete', jira: 'disconnect' }, pin);
    expect(pin).not.toHaveBeenCalled();
  });
});

describe('a host\'s removal: roomsOfHost and deleteRoomsOfHost', () => {
  it('keep: the rooms stay, read hostState removed once the host is a tombstone, and stay renamable', () => {
    const { rooms, db } = threeRooms();
    tombstone(db, 'birch');
    rooms.deleteRoomsOfHost('birch', 'keep');
    const kept = rooms.roomsOfHost('birch');
    expect(kept.map((room) => [room.id, room.hostState])).toEqual([['orchard', 'removed'], ['shop', 'removed']]);
    expect(rooms.get('harbor')?.hostState).toBe('ok');
    const orchard = kept[0]!;
    const renamed = rooms.update('orchard', { name: 'Old Orchard', colour: '#7c5cff', expectUpdatedAt: orchard.updatedAt });
    expect(renamed.room).toMatchObject({ name: 'Old Orchard', host: 'birch', hostState: 'removed' });
  });

  it('delete: the rooms go with their links and Jira sites, in one transaction', () => {
    const { rooms, db, events } = threeRooms();
    insertLink(db, 'shop', 's0', 0);
    insertJira(db, 'orchard');
    rooms.deleteRoomsOfHost('birch', 'delete');
    expect(rooms.list().items.map((room) => room.id)).toEqual(['harbor']);
    expect(linksOf(db, 'shop')).toEqual([]);
    expect(jiraRooms(db)).toEqual([]);
    expect(events.map((event) => event.name)).toEqual(expect.arrayContaining(['links.changed', 'jira.changed', 'accounts.changed']));
  });

  it('a host with no rooms changes nothing', () => {
    const { rooms, events } = rig();
    rooms.deleteRoomsOfHost('cedar', 'delete');
    expect(events).toEqual([]);
  });
});
