import { createConnectFlow } from '../google/connect-flow.js';
import { createGoogleService } from '../google/service.js';
import type { WireContext, Wired } from './context.js';

/**
 * Connect: Google (null without a Google client in the config) and the one link builder the
 * website and the chat commands share.
 */
export function wireConnect(ctx: WireContext): Wired {
  const { config } = ctx;
  const toOwner = ctx.get('toOwner');
  const meetings = ctx.get('meetings');
  const google = ctx.provide('google', config.google
    ? createGoogleService({
      db: ctx.get('db'), clock: ctx.get('clock'), log: ctx.get('log').child({ mod: 'google' }), outbound: toOwner({ kind: 'mail', source: 'hub' }),
      settings: ctx.get('settings'), secret: config.sessionSecret,
      reminders: toOwner({ kind: 'meeting', source: 'hub', urgent: true }),
      client: { ...config.google, redirectUri: `${config.publicOrigin}/api/google/callback` },
      toLuady: (text) => ctx.get('luady').postEvent(text, 'Event'),
      meetingContext: (title, startIso) => meetings.previousFor(title, startIso),
    })
    : null);
  const connect = ctx.provide('connect', createConnectFlow({
    google, meetings, clock: ctx.get('clock'), log: ctx.get('log').child({ mod: 'connect' }), publicOrigin: config.publicOrigin,
  }));
  return {
    name: 'connect',
    services: {},
    web: { google, connect },
    tools: { google },
    async start(phase) {
      if (phase === 'services' && google !== null) await ctx.start('google', () => google.start());
    },
    async stop(phase) {
      if (phase === 'services' && google !== null) await ctx.stop('google', () => google.stop());
    },
  };
}
