import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_DEFS, type RoomsDTO, type RoomWriteDTO } from '@luady/shared';
import type { ToolContext } from '../../src/core/contracts.js';
import { PinInvalidError } from '../../src/core/errors.js';
import { renderRoomsAuto } from '../../src/rooms/index.js';
import { ROOM_TOOLS } from '../../src/tools/room-tools.js';
import { call, fakePin, harnessFactory } from '../web/helpers.js';
import { NOW, insertJira, rig, serverRoom } from './helpers.js';

const harness = harnessFactory();

afterEach(() => {
  vi.useRealTimers();
});

async function withRooms() {
  const r = rig();
  const pin = fakePin();
  const h = await harness({ rooms: r.rooms, pin });
  return { ...r, h, pin, session: h.login() };
}

describe('the rooms routes', () => {
  it('GET lists the rooms with their grid; POST creates; PUT updates; move, order and delete answer as listed', async () => {
    const { h, session } = await withRooms();
    const created = await call(h, 'POST', '/api/rooms', { name: 'Orchard', kind: 'server', host: 'birch' }, { session });
    expect(created.statusCode).toBe(200);
    const room = (created.json() as RoomWriteDTO).room;
    expect(room.id).toBe('orchard');
    await call(h, 'POST', '/api/rooms', { name: 'Harbor', kind: 'server', host: 'ash' }, { session });
    const listed = (await call(h, 'GET', '/api/rooms', undefined, { session })).json() as RoomsDTO;
    expect(listed.items.map((r) => r.id)).toEqual(['orchard', 'harbor']);
    expect(listed.grid).toEqual({ slotCount: 2, K: 1, R: 1, capacity: 4 });
    const put = await call(h, 'PUT', '/api/rooms/orchard', { short: 'Orch', expectUpdatedAt: room.updatedAt }, { session });
    expect((put.json() as RoomWriteDTO).room.short).toBe('Orch');
    const moved = (await call(h, 'POST', '/api/rooms/orchard/move', { position: 1 }, { session })).json() as RoomsDTO;
    expect(moved.items.map((r) => [r.id, r.position])).toEqual([['harbor', 0], ['orchard', 1]]);
    const ordered = (await call(h, 'POST', '/api/rooms/order', { ids: ['orchard', 'harbor'] }, { session })).json() as RoomsDTO;
    expect(ordered.items.map((r) => r.id)).toEqual(['orchard', 'harbor']);
    const deleted = await call(h, 'POST', '/api/rooms/harbor/delete', { links: 'delete', jira: 'disconnect' }, { session });
    expect(deleted.json()).toEqual({ ok: true });
    const preview = await call(h, 'POST', '/api/rooms/preview', { kind: 'project', host: 'birch', match: [{ by: 'name', glob: 'x*' }] }, { session });
    expect(preview.json()).toEqual({ sessions: [], projects: [], overlaps: [] });
  });

  it('answers the coded refusals: 400 reserved_id, 409 home_room_exists, 409 room_conflict, 409 position_taken, 404', async () => {
    const { h, session } = await withRooms();
    for (const id of ['hq', 'lot-3', 'computer']) {
      const res = await call(h, 'POST', '/api/rooms', { name: `Room ${id}`, kind: 'server', host: 'birch', id }, { session });
      expect([res.statusCode, (res.json() as { error: { code: string } }).error.code], id).toEqual([400, 'reserved_id']);
    }
    const first = (await call(h, 'POST', '/api/rooms', { name: 'Orchard', kind: 'server', host: 'birch' }, { session })).json() as RoomWriteDTO;
    const twice = await call(h, 'POST', '/api/rooms', { name: 'Orchard 2', kind: 'server', host: 'birch' }, { session });
    expect([twice.statusCode, twice.json()]).toEqual([409, { error: expect.objectContaining({ code: 'home_room_exists' }) }]);
    await call(h, 'PUT', '/api/rooms/orchard', { species: 'cat', expectUpdatedAt: first.room.updatedAt }, { session });
    const stale = await call(h, 'PUT', '/api/rooms/orchard', { species: 'bot', expectUpdatedAt: first.room.updatedAt }, { session });
    expect([stale.statusCode, stale.json()]).toEqual([409, { error: expect.objectContaining({ code: 'room_conflict' }) }]);
    const taken = await call(h, 'POST', '/api/rooms', { name: 'Harbor', kind: 'server', host: 'ash', position: 0 }, { session });
    expect([taken.statusCode, taken.json()]).toEqual([409, { error: expect.objectContaining({ code: 'position_taken' }) }]);
    expect((await call(h, 'POST', '/api/rooms/nowhere/move', { position: 1 }, { session })).statusCode).toBe(404);
    expect((await call(h, 'PUT', '/api/rooms/Bad_Id', { expectUpdatedAt: 'x' }, { session })).statusCode).toBe(400);
  });

  it('a removal that disconnects Jira needs the PIN: 428 without it, 403 with a wrong one, done with the right one', async () => {
    const { h, session, db, pin, rooms } = await withRooms();
    rooms.create(serverRoom('birch', 'Orchard'));
    insertJira(db, 'orchard');
    const missing = await call(h, 'POST', '/api/rooms/orchard/delete', { links: 'delete', jira: 'disconnect' }, { session });
    expect([missing.statusCode, missing.json()]).toEqual([428, { error: expect.objectContaining({ code: 'pin_required' }) }]);
    vi.mocked(pin.verify).mockRejectedValueOnce(new PinInvalidError(4));
    const wrong = await call(h, 'POST', '/api/rooms/orchard/delete', { links: 'delete', jira: 'disconnect', pin: '000000' }, { session });
    expect(wrong.statusCode).toBe(403);
    expect(rooms.get('orchard')).not.toBeNull();
    const done = await call(h, 'POST', '/api/rooms/orchard/delete', { links: 'delete', jira: 'disconnect', pin: '123456' }, { session });
    expect(done.json()).toEqual({ ok: true });
    expect(pin.verify).toHaveBeenLastCalledWith('123456', 'web');
  });

  it('a session alone may not write: no CSRF token, no change', async () => {
    const { h, session, rooms } = await withRooms();
    const res = await call(h, 'POST', '/api/rooms', { name: 'Orchard', kind: 'server', host: 'birch' }, { session, csrf: null });
    expect(res.statusCode).toBe(403);
    expect(rooms.list().items).toEqual([]);
  });
});

describe('the manager reads the rooms: rooms_list and ROOMS.auto.md', () => {
  it('rooms_list answers one line per room, read-only', async () => {
    const { rooms } = rig();
    rooms.create(serverRoom('birch', 'Orchard'));
    rooms.create({ name: 'Docs', kind: 'project', host: null, match: [{ by: 'name', glob: 'docs-*' }] });
    expect(TOOL_DEFS.rooms_list.input.safeParse({}).success).toBe(true);
    const text = await ROOM_TOOLS.rooms_list({}, { rooms } as unknown as ToolContext);
    expect(text).toBe([
      'Rooms: 2 (the office has 4 slots)',
      '- **Orchard** (`orchard`) · server room · host birch · everything on its host · slot 0',
      '- **Docs** (`docs`) · project room · any host · name docs-* · slot 1',
    ].join('\n'));
  });

  it('ROOMS.auto.md is written after a change, and says so when there are no rooms', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'rooms-brain-'));
    const { rooms } = rig({ brainDir });
    rooms.create(serverRoom('birch', 'Orchard'));
    await vi.waitFor(() => expect(readFileSync(join(brainDir, 'memory', 'ROOMS.auto.md'), 'utf8')).toContain('**Orchard** (`orchard`)'));
    expect(renderRoomsAuto([], NOW)).toContain('No rooms yet.');
  });
});
