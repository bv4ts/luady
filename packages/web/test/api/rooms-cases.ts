import { roomDto } from '../room-fixtures.js';
import type { StepCRouteCase } from './step-c-cases.js';

/** Route cases for the rooms API, shared with client.test.ts. */
const ROOM = roomDto();
const GRID = { slotCount: 1, K: 1, R: 1, capacity: 4 };
const LIST = { items: [ROOM], grid: GRID };
const WRITE = { room: ROOM, adjusted: { colour: false, accent: false }, warnings: [] };

export const ROOM_CASES: StepCRouteCase[] = [
  { name: 'rooms', call: (a) => a.rooms(), method: 'GET', url: '/api/rooms', response: LIST },
  {
    name: 'createRoom', call: (a) => a.createRoom({ name: 'Mars', kind: 'server', host: 'mars' }), method: 'POST', url: '/api/rooms',
    body: { name: 'Mars', kind: 'server', host: 'mars' }, response: WRITE,
  },
  {
    name: 'updateRoom', call: (a) => a.updateRoom('mars', { name: 'Red planet', expectUpdatedAt: ROOM.updatedAt }), method: 'PUT',
    url: '/api/rooms/mars', body: { name: 'Red planet', expectUpdatedAt: ROOM.updatedAt }, response: WRITE,
  },
  { name: 'orderRooms', call: (a) => a.orderRooms(['mars']), method: 'POST', url: '/api/rooms/order', body: { ids: ['mars'] }, response: LIST },
  { name: 'moveRoom', call: (a) => a.moveRoom('mars', 3), method: 'POST', url: '/api/rooms/mars/move', body: { position: 3 }, response: LIST },
  {
    name: 'deleteRoom', call: (a) => a.deleteRoom('mars', { links: 'delete', jira: 'disconnect', pin: '123456' }), method: 'POST',
    url: '/api/rooms/mars/delete', body: { links: 'delete', jira: 'disconnect', pin: '123456' }, response: { ok: true },
  },
  {
    name: 'previewRoom', call: (a) => a.previewRoom({ kind: 'project', host: null, match: [{ by: 'name', glob: 'web*' }] }), method: 'POST',
    url: '/api/rooms/preview', body: { kind: 'project', host: null, match: [{ by: 'name', glob: 'web*' }] },
    response: { sessions: [], projects: ['web-app'], overlaps: [] },
  },
];
