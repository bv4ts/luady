import { z } from 'zod';
import { PresenceForceBodySchema, type NoticeListDTO, type PresenceDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { parseBody, parseQuery } from '../validate.js';

const NoticesQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** What Luady and the hub told the owner (website first), and where updates go now. */
export const noticeRoutes: RouteModule = (app, ctx) => {
  const { notices, presence, log } = ctx.deps;
  app.get('/api/notices', async (request): Promise<NoticeListDTO> => {
    const { limit } = parseQuery(NoticesQuerySchema, request.query);
    return { items: notices.list(limit) };
  });
  app.get('/api/presence', async (): Promise<PresenceDTO> => presence.state());
  app.put('/api/presence', async (request): Promise<PresenceDTO> => {
    const toChat = parseBody(PresenceForceBodySchema, request.body).chat;
    const state = presence.force(toChat);
    log.info({ forcedUntil: state.forcedUntil }, toChat ? 'presence: owner forced updates to the chat' : 'presence: owner cleared the forced chat');
    return state;
  });
};
