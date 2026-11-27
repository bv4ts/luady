import {
  RoomCreateBodySchema, RoomDeleteBodySchema, RoomMoveBodySchema, RoomOrderBodySchema, RoomPreviewBodySchema, RoomPreviewDTOSchema,
  RoomUpdateBodySchema, RoomWriteDTOSchema, RoomsDTOSchema,
} from '@luady/shared';
import { z } from 'zod';
import { checked, seg, type Verbs } from './verbs.js';

export type RoomCreateInput = z.input<typeof RoomCreateBodySchema>;
export type RoomUpdateInput = z.input<typeof RoomUpdateBodySchema>;
export type RoomDeleteInput = z.input<typeof RoomDeleteBodySchema>;
export type RoomPreviewInput = z.input<typeof RoomPreviewBodySchema>;

const RoomRemovedSchema = z.object({ ok: z.literal(true) });

/** The rooms API: one function per route. */
export function roomRoutes({ get, post, put }: Verbs) {
  const room = (id: string): string => `/api/rooms/${seg(id)}`;
  return {
    rooms: () => get('/api/rooms', RoomsDTOSchema),
    createRoom: async (body: RoomCreateInput) => post('/api/rooms', RoomWriteDTOSchema, checked(RoomCreateBodySchema, body)),
    /** 409 `room_conflict` when the room changed since `expectUpdatedAt`. */
    updateRoom: async (id: string, body: RoomUpdateInput) => put(room(id), RoomWriteDTOSchema, checked(RoomUpdateBodySchema, body)),
    /** Every room id, in the new order: positions become 0..n-1 (also "Close gaps"). */
    orderRooms: async (ids: readonly string[]) => post('/api/rooms/order', RoomsDTOSchema, checked(RoomOrderBodySchema, { ids })),
    /** Into a free slot, or a swap with the slot's room. */
    moveRoom: async (id: string, position: number) => post(`${room(id)}/move`, RoomsDTOSchema, checked(RoomMoveBodySchema, { position })),
    deleteRoom: async (id: string, body: RoomDeleteInput) => post(`${room(id)}/delete`, RoomRemovedSchema, checked(RoomDeleteBodySchema, body)),
    previewRoom: async (body: RoomPreviewInput) => post('/api/rooms/preview', RoomPreviewDTOSchema, checked(RoomPreviewBodySchema, body)),
  };
}
