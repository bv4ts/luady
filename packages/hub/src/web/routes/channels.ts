import { z } from 'zod';
import { AddonIdSchema, ChannelActionBodySchema, type ChannelInfoDTO } from '@luady/shared';
import type { RouteModule } from '../context.js';
import { errorBody } from '../errors.js';
import { parseBody, parseParams } from '../validate.js';
import { registerFileRoutes } from './files.js';

const ChannelParamsSchema = z.strictObject({ id: AddonIdSchema });

/**
 * Channels and add-ons: the declared add-ons as data, a panel action (with the PIN when its block
 * says so), and the files the website keeps for the owner. Registered only when the channels service is present.
 */
export const channelRoutes: RouteModule = (app, ctx) => {
  const { channels, pin } = ctx.deps;
  if (channels === undefined) return;
  app.get('/api/channels', async (): Promise<ChannelInfoDTO[]> => channels.list());
  app.post('/api/channels/:id/action', async (request, reply) => {
    const { id } = parseParams(ChannelParamsSchema, request.params);
    const body = parseBody(ChannelActionBodySchema, request.body);
    // Only an action the add-on's current panel offers; anything else is unknown.
    const block = channels.panelBlock(id, body.action);
    if (block === null) return reply.code(404).send(errorBody('not_found', 'That action is not on this channel\'s panel'));
    if (block.type === 'button' && block.pin === true) {
      if (body.pin === undefined) return reply.code(428).send(errorBody('pin_required', 'PIN required for this action'));
      await pin.verify(body.pin, 'web');
    }
    const value = block.type === 'input' ? body.value ?? '' : null;
    if (!channels.uiAction(id, body.action, value)) return reply.code(409).send(errorBody('refused', 'The add-on is not connected right now'));
    return { ok: true as const };
  });
  registerFileRoutes(app, channels);
};
