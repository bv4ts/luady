import type { PrefsService, RecapService, SaidService, TimelineService, ToolContext } from '../core/contracts.js';
import type { NotesHub } from '../notes/index.js';
import { createInternalServer } from '../internal/server.js';
import { createImapService } from '../mail/imap.js';
import { createNotesService } from '../notes/index.js';
import { createVoiceServer } from '../phone/server.js';
import { createNullPhone } from '../phone/null.js';
import { createTwilioPhone } from '../phone/service.js';
import { createTwilioClient } from '../phone/twilio.js';
import { createPrefsService } from '../prefs/index.js';
import { createRecapService } from '../recap/index.js';
import { createSaidService } from '../said/index.js';
import { createTimelineService } from '../timeline/index.js';
import { createToolHandlers } from '../tools/handlers.js';
import { createHostCheck } from '../web/host-check.js';
import type { WireContext, Wired } from './context.js';

/** What this module adds to App.services. */
export interface DomainServices {
  notes: NotesHub;
  said: SaidService;
  recap: RecapService;
  timeline: TimelineService;
  prefs: PrefsService;
}

/** The IMAP mailbox is checked every 2 minutes, like Gmail. */
const IMAP_TICK_MS = 2 * 60_000;

/**
 * Domain: the phone and Twilio, IMAP and its timer, notes, said and recap, prefs and the timeline; the voice server
 * (with the Host check); the internal server, fed by every module's `internal` routes; and the tool handlers and the
 * tool context, merged from every module's `tools`.
 */
export function wireDomain(ctx: WireContext): Wired {
  const { config, overrides } = ctx;
  const db = ctx.get('db');
  const bus = ctx.get('bus');
  const clock = ctx.get('clock');
  const log = ctx.get('log');
  const settings = ctx.get('settings');
  const toOwner = ctx.get('toOwner');
  const toManager = (text: string): Promise<void> => ctx.get('luady').postEvent(text, 'Event');
  // The phone needs Twilio, its way in and the owner's number; without any of them it stays off.
  const twilioPhone = ctx.provide('twilioPhone', overrides.phone === undefined && config.twilio && config.voiceOrigin && config.ownerPhone !== undefined
    ? createTwilioPhone({
      client: createTwilioClient(config.twilio), origin: config.voiceOrigin, ownerPhone: config.ownerPhone, clock,
      log: log.child({ mod: 'phone' }), settings, questions: ctx.get('questions'), outbound: toOwner({ kind: 'alert', source: 'hub' }),
      luady: () => ctx.get('luady'),
    })
    : null);
  const phone = ctx.provide('phone', overrides.phone ?? twilioPhone ?? createNullPhone());
  const imap = ctx.provide('imap', config.imap
    ? createImapService({
      db, clock, log: log.child({ mod: 'imap' }), outbound: toOwner({ kind: 'mail', source: 'hub' }), settings, account: config.imap,
      toLuady: toManager,
    })
    : null);
  const notes = ctx.provide('notes', createNotesService({
    db, bus, clock, log: log.child({ mod: 'notes' }), meetings: ctx.get('meetings'), luady: ctx.get('luady'),
  }));
  const said = ctx.provide('said', createSaidService({ bus, clock, log: log.child({ mod: 'said' }), sessions: ctx.get('sessions') }));
  const recap = ctx.provide('recap', createRecapService({ db, clock, log: log.child({ mod: 'recap' }), questions: ctx.get('questions') }));
  const timeline = ctx.provide('timeline', createTimelineService({ db, clock, log: log.child({ mod: 'timeline' }), sessions: ctx.get('sessions') }));
  const prefs = ctx.provide('prefs', createPrefsService({ db, bus, clock, log: log.child({ mod: 'prefs' }) }));
  let imapTimer: ReturnType<typeof setInterval> | null = null;

  return {
    name: 'domain',
    services: { notes, said, recap, timeline, prefs } satisfies DomainServices,
    web: { notes, said, recap, timeline, prefs },
    tools: { phone, imap, notes },
    async compose(all) {
      const toolContext = { ...all.tools } as ToolContext;
      ctx.traceKeys('toolContext', Object.keys(toolContext));
      ctx.provide('internalServer', await createInternalServer({
        config, log, handlers: createToolHandlers(), toolContext, onOwnerTold: () => ctx.get('luady').ownerTold?.(), routes: all.internal,
        managerReady: () => ctx.get('managerControl').ready(),
      }));
      ctx.provide('voiceServer', twilioPhone !== null && config.twilio && config.voiceOrigin
        ? await createVoiceServer({
          phone: twilioPhone, authToken: config.twilio.authToken, origin: config.voiceOrigin, log: log.child({ mod: 'voice' }),
          hostCheck: createHostCheck(config),
        })
        : null);
    },
    async start(phase) {
      if (phase !== 'services') return;
      await ctx.start('notes', () => notes.start());
      await ctx.start('said', () => said.start());
      if (imap !== null) {
        await ctx.start('imap', () => {
          imapTimer = setInterval(() => {
            imap.tick().catch((err: unknown) => log.warn({ err: err instanceof Error ? err.message : String(err) }, 'imap: check failed'));
          }, IMAP_TICK_MS);
        });
      }
    },
    async stop(phase) {
      if (phase !== 'services') return;
      if (twilioPhone !== null) await ctx.stop('phone', () => twilioPhone.stop());
      if (imap !== null) {
        await ctx.stop('imap', () => {
          if (imapTimer !== null) clearInterval(imapTimer);
          imapTimer = null;
        });
      }
      await ctx.stop('said', () => said.stop());
      await ctx.stop('notes', () => notes.stop());
    },
  };
}
