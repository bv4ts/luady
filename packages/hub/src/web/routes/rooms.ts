import { z } from 'zod';
import {
  RoomCreateBodySchema, RoomDeleteBodySchema, RoomIdSchema, RoomMoveBodySchema, RoomOrderBodySchema, RoomPreviewBodySchema,
  RoomUpdateBodySchema, isNewRoomId, isRoomId, type RoomPreviewDTO, type RoomWriteDTO, type RoomsDTO,
} from '@luady/shared';
import { RoomInvalidError } from '../../rooms/errors.js';
import type { RouteModule } from '../context.js';
import { PinRequiredError } from '../errors.js';
import { parseBody, parseParams } from '../validate.js';

const RoomParamsSchema = z.strictObject({ id: RoomIdSchema });

/** A chosen id that is a reserved word or names a lot is refused with its own code (400 `reserved_id`). */
function refuseReservedId(body: unknown): void {
  const id = typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;
  if (typeof id === 'string' && isRoomId(id) && !isNewRoomId(id)) {
    throw new RoomInvalidError('reserved_id', `${id} is a reserved name; choose another id`);
  }
}

/**
 * Rooms. Registered only when the rooms service is present (routes/index.ts). Every route sits
 * behind the session, the page key and (for writes) the CSRF check of the chain; removing a room whose Jira site would
 * be disconnected also needs the PIN, checked here as the Jira routes do.
 */
export const roomRoutes: RouteModule = (app, ctx) => {
  const { rooms, pin } = ctx.deps;
  if (rooms === undefined) return;
  const idOf = (params: unknown): string => parseParams(RoomParamsSchema, params).id;

  app.get('/api/rooms', async (): Promise<RoomsDTO> => rooms.list());
  app.post('/api/rooms', async (request): Promise<RoomWriteDTO> => {
    refuseReservedId(request.body);
    return rooms.create(parseBody(RoomCreateBodySchema, request.body));
  });
  app.post('/api/rooms/order', async (request): Promise<RoomsDTO> => rooms.order(parseBody(RoomOrderBodySchema, request.body).ids));
  app.post('/api/rooms/preview', async (request): Promise<RoomPreviewDTO> => rooms.preview(parseBody(RoomPreviewBodySchema, request.body)));
  app.put('/api/rooms/:id', async (request): Promise<RoomWriteDTO> => rooms.update(idOf(request.params), parseBody(RoomUpdateBodySchema, request.body)));
  app.post('/api/rooms/:id/move', async (request): Promise<RoomsDTO> =>
    rooms.move(idOf(request.params), parseBody(RoomMoveBodySchema, request.body).position));
  app.post('/api/rooms/:id/delete', async (request): Promise<{ ok: true }> => {
    const id = idOf(request.params);
    await rooms.remove(id, parseBody(RoomDeleteBodySchema, request.body), async (code) => {
      if (code === undefined) throw new PinRequiredError('PIN required: removing this room disconnects its Jira site');
      await pin.verify(code, 'web');
    });
    return { ok: true };
  });
};
