import { posix } from 'node:path';
import { isSelfHost, type NoticeKind } from '@luady/shared';
import { withCachedStatus } from '../accounts/codex-status.js';
import { createAddonTools } from '../channels/addon-tools.js';
import { loadAddons } from '../channels/addons-file.js';
import { createChannelHost } from '../channels/host.js';
import { createLinkStore } from '../channels/link-store.js';
import { createOutbox } from '../channels/outbox.js';
import { createOwnerChannel } from '../channels/owner-channel.js';
import { createChannelsService, handleDeliver, noticeFileOf } from '../channels/service.js';
import { createChatLogin } from '../claude-login/chat-login.js';
import type { OutboundLink } from '../core/contracts.js';
import { createInboundRouter } from '../inbound/router.js';
import { pruneInbox } from '../inbound/media.js';
import { codexUserHome, ensureCodexHome, hubCodexHome } from '../media/codex.js';
import { createCodexLogin } from '../media/codex-login.js';
import { REFERENCE_MAX_BYTES } from '../media/image-refs.js';
import { createImageGenerator } from '../media/imagegen.js';
import { createMeetingsService } from '../meetings/service.js';
import { createMissionService } from '../missions/service.js';
import { ownerChannels } from '../notices/owner.js';
import { sourceOfChannel } from '../notices/policy.js';
import { createPresenceService } from '../notices/presence.js';
import { createRefState } from '../notices/ref-state.js';
import { createNoticeRouter } from '../notices/router.js';
import { createNoticeState } from '../notices/state.js';
import { PROFILE_ABOUT, profileDescription } from '../notify/format.js';
import { createNotifyService } from '../notify/service.js';
import { createTodoService } from '../todos/service.js';
import type { WireContext, Wired } from './context.js';

/** The outbox and the brain inbox are swept this often (files older than 30 and 14 days). */
const SWEEP_MS = 60 * 60_000;

/**
 * Channels: the add-on host and its route, the owner channel facade, the outbox, notice state, presence and router,
 * the owner senders, missions, to-dos, meetings, images and the Codex sign-in, the tools update, the inbound router,
 * notify, the add-on tools and the profile. No chat app is built in: with no add-on everything meant for the owner
 * lands on the website.
 */
export function wireChannels(ctx: WireContext): Wired {
  const { config } = ctx;
  const db = ctx.get('db');
  const bus = ctx.get('bus');
  const clock = ctx.get('clock');
  const log = ctx.get('log');
  const settings = ctx.get('settings');
  const fleet = ctx.get('fleet');
  const questions = ctx.get('questions');
  const sessions = ctx.get('sessions');
  const pauses = ctx.get('pauses');
  const inboxDir = posix.join(config.brainDir, 'inbox');
  const addonLog = log.child({ mod: 'addons' });

  const addons = loadAddons({ config, log: addonLog });
  const host = createChannelHost({ addons, bus, clock, log: addonLog });
  const links = createLinkStore(db);
  const outbox = createOutbox({ config, clock, log: log.child({ mod: 'outbox' }) });
  /** What cannot reach the chat is kept on the website as a notice of this kind. */
  const kindOf = (link: OutboundLink | null): NoticeKind => {
    if (link?.kind === 'question') return questions.get(link.refId)?.kind === 'permission' ? 'permission' : 'question';
    if (link?.kind === 'action') return 'permission';
    return 'system';
  };
  const ownerChannel = createOwnerChannel({
    host, addons, links, outbox, bus, clock, log: log.child({ mod: 'channels' }),
    website: () => ({
      keep: async ({ text, link, file }) => ctx.get('notices').keep({
        kind: kindOf(link), text, ref: link === null ? null : { kind: link.kind, id: link.refId }, ...(file === undefined ? {} : { fileId: file.id }),
      }),
    }),
  });
  ctx.provide('ownerChannel', ownerChannel);
  const channels = ctx.provide('channels', createChannelsService({ host, outbox }));
  const addonTools = createAddonTools({ host, addons, log: addonLog, brainDir: config.brainDir });

  const noticeState = createNoticeState(db);
  const presence = ctx.provide('presence', createPresenceService({ bus, clock, state: noticeState, settings }));
  const notices = ctx.provide('notices', createNoticeRouter({
    db, bus, clock, log: log.child({ mod: 'notices' }), chat: ownerChannel, presence, state: noticeState, settings,
    files: { byNotice: (id) => noticeFileOf(outbox.byNotice(id)), byId: (id) => noticeFileOf(outbox.get(id)) },
    // Before a fallback sends a question or a confirmation: still waiting? Unknown until its server reported in,
    // or two minutes after the start, whichever comes first.
    refState: createRefState({
      clock, startedAt: clock.now().getTime(), action: (id) => ctx.get('actions').get(id), question: (qid) => questions.get(qid),
      reconciled: (host) => questions.reconciled(host),
    }),
  }));
  /** Owner-facing senders get this instead of the raw channel: website first while the owner is there. */
  const toOwner = ctx.provide('toOwner', ownerChannels({
    router: notices, chat: ownerChannel, questions, turnSource: () => ctx.get('luady').turnSource?.() ?? null,
  }));
  const missions = ctx.provide('missions', createMissionService({
    db, bus, clock, log: log.child({ mod: 'missions' }), settings, sessions,
    outbound: toOwner({ kind: 'result', source: 'hub', awayOnly: true }),
    results: toOwner({ kind: 'result', source: 'hub' }),
  }));
  const todos = ctx.provide('todos', createTodoService({
    db, clock, log: log.child({ mod: 'todos' }), outbound: ownerChannel,
    // The pinned "today" list unpinned: the cards it cleared reach the website like any other card change.
    onTodayCleared: (ids) => {
      const items = ids.flatMap((id) => ctx.get('board').get(id) ?? []);
      if (items.length > 0) bus.emit('board.updated', { items });
    },
  }));
  const toManager = (text: string): Promise<void> => ctx.get('luady').postEvent(text, 'Event');
  const meetings = ctx.provide('meetings', createMeetingsService({
    db, clock, log: log.child({ mod: 'wispr' }), outbound: toOwner({ kind: 'meeting', source: 'hub' }), secret: config.sessionSecret,
    redirectUri: `${config.publicOrigin}/api/wispr/callback`, toLuady: toManager,
  }));
  // The Codex CLI is in the hub user's own ~/.local/bin (the nightly tools update installs it there); its home, with the
  // ChatGPT sign-in for pictures, is the hub's own inside the data folder, apart from the user's ~/.codex.
  const home = codexUserHome();
  const codexDir = hubCodexHome(config.dataDir);
  try {
    ensureCodexHome(codexDir);
  } catch (err) {
    log.warn({ err }, 'codex: its home in the data folder could not be made');
  }
  const images = ctx.provide('images', createImageGenerator({
    home, codexDir, dir: posix.join(inboxDir, 'images'), inboxDir, log: log.child({ mod: 'images' }), outbound: ownerChannel, notifyLuady: toManager,
    fetchServerFile: async (server, path) => Buffer.from((await fleet.client(server).fileGet(path, REFERENCE_MAX_BYTES)).b64, 'base64'),
    hasServer: (id) => fleet.hasServer(id),
  }));
  // `codex login status` runs at most once a minute, never on every GET /api/accounts (accounts/codex-status.ts).
  const codexLogin = ctx.provide('codexLogin', withCachedStatus(
    createCodexLogin({ home, codexDir, log: log.child({ mod: 'codex-login' }), outbound: ownerChannel, clock }),
    { clock, log: log.child({ mod: 'accounts' }) },
  ));
  ctx.provide('updateTools', async () =>
    images.update().then((codex) => log.info({ codex }, 'codex self-update'), (err: unknown) => log.warn({ err }, 'codex self-update failed')));
  const router = createInboundRouter({
    clock, log, links, outbound: ownerChannel, outboundFor: (channel) => ownerChannel.onChannel(channel), questions, sessions, actions: ctx.get('actions'), luady: ctx.later('luady'), settings,
    phone: ctx.later('phone'), fleet, missions, todos, board: ctx.get('board'),
    media: { root: (channel) => addons.filesDir(channel), inboxDir },
    googleStatus: () => ctx.get('connect').googleStatusText(),
    login: createChatLogin(ctx.get('claudeLogin'), clock, () => fleet.hosts().filter((id) => !isSelfHost(id))),
    wispr: { command: (arg) => ctx.get('connect').wisprCommand(arg) },
    notices,
  });
  const unsubscribe = host.subscribe({
    incoming: (id, frame) => router.handle(id, frame),
    deliver: handleDeliver({ host, addons, owner: ownerChannel, text: toOwner({ kind: 'result', source: 'hub' }), clock, log: addonLog }),
  });
  const notify = createNotifyService({
    db, bus, clock, log, outbound: toOwner({ kind: 'alert', source: 'hub' }), settings, questions, sessions, phone: ctx.later('phone'),
    missions, toLuady: toManager, isHeld: pauses.isHeld, onReleased: pauses.onReleased,
  });
  // The manager's tools (notify_user, send_file) speak for the running turn: a reply to a chat turn goes back there.
  // During the morning brief turn they send the morning message: to the chat at once, always.
  const toolOutbound = toOwner({
    kind: () => (ctx.get('luady').morningTurn?.() === true ? 'morning' : 'result'),
    source: () => sourceOfChannel(ctx.get('luady').turnSource?.() ?? null),
  });
  let sweeper: ReturnType<typeof setInterval> | null = null;
  const sweep = (): void => {
    try {
      outbox.sweep();
    } catch (err) {
      log.warn({ err }, 'outbox: sweep failed');
    }
    pruneInbox(inboxDir, clock.now().getTime()).catch((err: unknown) => log.warn({ err }, 'inbox: prune failed'));
  };

  return {
    name: 'channels',
    services: { notices, presence },
    web: { notices, presence, meetings, codexLogin, channels },
    internal: [host.route()],
    tools: {
      outbound: toolOutbound, missions, images, todos, meetings, presence,
      addons: { tools: addonTools, isAddonToken: (bearer) => addons.isAddonToken(bearer) },
    },
    async start(phase) {
      if (phase !== 'services') return;
      await ctx.start('presence', () => presence.start());
      await ctx.start('notices', () => notices.start());
      await ctx.start('notify', () => notify.start());
      await ctx.start('missions', () => missions.start());
      await ctx.start('todos', () => todos.start());
      await ctx.start('meetings', () => meetings.start());
      await ctx.start('outbox', () => {
        sweep();
        sweeper = setInterval(sweep, SWEEP_MS);
        sweeper.unref?.();
      });
      await ctx.start('profile', () => ownerChannel.setProfile(PROFILE_ABOUT, profileDescription()));
    },
    async stop(phase) {
      if (phase !== 'services') return;
      await ctx.stop('addons', () => {
        unsubscribe();
        addonTools.stop();
        host.stop();
        ownerChannel.stop();
      });
      await ctx.stop('outbox', () => {
        if (sweeper !== null) clearInterval(sweeper);
        sweeper = null;
      });
      await ctx.stop('meetings', () => meetings.stop());
      await ctx.stop('todos', () => todos.stop());
      await ctx.stop('missions', () => missions.stop());
      await ctx.stop('notify', () => notify.stop());
      await ctx.stop('notices', () => notices.stop());
      await ctx.stop('presence', () => presence.stop());
    },
  };
}
