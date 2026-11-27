import { createRoomsService, seedRooms } from '../rooms/index.js';
import type { WireContext, Wired } from './context.js';

/**
 * Rooms: the rooms service, then `seedRooms`, last, once the fleet and the config host rows exist
 * (the fleet writes them while it is wired), so every imported room passes the host check. The website gets the
 * rooms routes (registered because the service is present), the manager the `rooms_list` tool.
 */
export function wireRooms(ctx: WireContext): Wired {
  const { config } = ctx;
  const log = ctx.get('log').child({ mod: 'rooms' });
  const rooms = ctx.provide('rooms', createRoomsService({
    db: ctx.get('db'), bus: ctx.get('bus'), clock: ctx.get('clock'), log, fleet: ctx.get('fleet'),
    sessions: () => ctx.get('sessions').list(), projects: () => ctx.get('projects').list(), brainDir: config.brainDir,
  }));
  seedRooms(rooms, config, log);
  return {
    name: 'rooms',
    services: { rooms },
    web: { rooms },
    tools: { rooms },
    async stop(phase) {
      if (phase === 'services') await ctx.stop('rooms', () => rooms.stop());
    },
  };
}
