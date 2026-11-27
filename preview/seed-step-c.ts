import type { BoardItemDTO, CreateKbPageBody, KbAuthor, HostId } from '@luady/shared';
import type { BoardActor, BoardAddInput, BoardPatch, Db } from '../packages/hub/dist/core/contracts.js';
import { createMeetingStore } from '../packages/hub/dist/meetings/store.js';

/**
 * The seed: cards in every lane, two typed notes and one meeting with action items, and knowledge pages for
 * everyone, an office and two projects (one pinned, one in Arabic). Runs once per database.
 */

export interface StepCSeedHub {
  readonly db: Db;
  readonly board: {
    list(): BoardItemDTO[];
    add(input: BoardAddInput, by: BoardActor): Promise<BoardItemDTO>;
    update(id: number, patch: BoardPatch, by: BoardActor): Promise<BoardItemDTO>;
    link(sessionId: string, ids: readonly number[]): Promise<void>;
  };
  readonly notes: { create(body: { title?: string; body: string; project?: string }): Promise<{ id: string }> };
  readonly kb: {
    create(body: CreateKbPageBody, by: KbAuthor): Promise<{ id: number }>;
    update(id: number, body: { pinned?: boolean }, by: KbAuthor): Promise<unknown>;
  };
  readonly clock: () => Date;
}

export const SEED_MEETING_ID = 'preview-standup-1115';
/** Live preview sessions the running cards are linked to (seed.ts: both are working). */
export const RUNNING_SESSIONS = { checkout: 'birch:cc-checkout-fix:0.0', admin: 'ash:cc-harbor-admin:0.0', push: 'birch:cc-push-notifs:0.0' } as const;

const HOUR_MS = 3_600_000;

interface CardSeed {
  readonly input: Omit<BoardAddInput, 'source'> & { readonly source?: BoardAddInput['source'] };
  readonly then?: BoardPatch;
  readonly link?: string;
}

const card = (title: string, server: HostId | null, project: string | null, extra: Partial<CardSeed['input']> = {}): CardSeed['input'] => ({
  title, server, project, ...extra,
});

function cards(meetingNote: string, typedNote: string): readonly CardSeed[] {
  return [
    // To do: today and high first.
    { input: card('Fix the checkout total (delivery fee is missing)', 'birch', 'app-backend', {
      today: true, priority: 1, details: 'The last checkout step adds the basket only. See ORC-1101.\n\n- add the fee\n- add a test',
    }) },
    { input: card('Renew the Harbor SSL certificate', 'ash', 'harbor-web-app', { today: true }) },
    { input: card('Prepare the October VAT return', 'cedar', 'meadow-vat', { priority: 1, source: 'web' }) },
    { input: card('Ask Sara about the rider app crash', null, null, { source: 'meeting', sourceRef: meetingNote }) },
    { input: card('Update the menu import guide', 'birch', 'menu-import', { source: 'note', sourceRef: typedNote }) },
    { input: card('مراجعة نصوص الصفحة الرئيسية بالعربية', 'ash', 'harbor-new-home') },
    // Running, linked to live preview sessions.
    { input: card('Saved cards for returning customers', 'birch', 'checkout-fix', { details: 'Show saved cards first; newest selected.' }), link: RUNNING_SESSIONS.checkout },
    { input: card('Export orders as CSV from the admin', 'ash', 'harbor-admin'), link: RUNNING_SESSIONS.admin },
    // Needs you: a session that stopped on an error, and one blocked by a report.
    { input: card('Push notifications stopped on Android', 'birch', 'push-notifs'), link: RUNNING_SESSIONS.push },
    { input: card('Move the Meadow backups to the new bucket', 'cedar', 'meadow-share'), then: {
      state: 'review', note: '#10 blocked: the new bucket has no write key yet. Add MEADOW_BACKUP_KEY on cedar.',
    } },
    // Done with results.
    { input: card('Release notes for 4.12', 'birch', 'release-notes'), then: { state: 'done', result: 'Release notes written and posted in #releases.' } },
    { input: card('Harbor: fix the Arabic menu order', 'ash', 'harbor-web-app'), then: { state: 'done', result: 'Menu order fixed for right to left; checked on phone and desktop.' } },
    { input: card('Payroll export for October', 'cedar', 'meadow-hr', { source: 'web' }), then: { state: 'done', result: 'Exported and matched with last month (2 new staff).' } },
  ];
}

const MEETING_SUMMARY = [
  'Checkout v2 is on track for Thursday except the delivery fee bug.',
  'The rider app crash on Android 15 needs an owner.',
  'Release notes for 4.12 are out.',
].join('\n');
const MEETING_TODOS = ['- [Owner] Fix the delivery fee in the checkout total', '- [Owner] Ask Sara about the rider app crash', '- [Omar] Check the promo code report'].join('\n');

function seedMeeting(db: Db, now: Date): string {
  const store = createMeetingStore(db);
  const started = new Date(now.getTime() - 20 * HOUR_MS).toISOString();
  const ended = new Date(now.getTime() - 19.5 * HOUR_MS).toISOString();
  const at = now.toISOString();
  store.upsert({
    id: SEED_MEETING_ID, title: 'Orchard stand-up', startedAt: started, endedAt: ended, finalized: true, shared: false,
    people: 'Omar, Sara, the owner', excerpt: MEETING_SUMMARY, link: '',
  }, 'announced', at);
  store.setDetails(SEED_MEETING_ID, { summary: MEETING_SUMMARY, todos: MEETING_TODOS }, at);
  store.note(SEED_MEETING_ID, { gist: 'Checkout v2 on track; delivery fee bug first.', project: 'app-backend' }, at);
  return `m:${SEED_MEETING_ID}`;
}

const KB_PAGES: readonly (CreateKbPageBody & { readonly pinned?: boolean })[] = [
  {
    scope: 'global', title: 'How we work', pinned: true, tags: ['rules'],
    body: '# How we work\n\n- Read your project\'s pages in `~/luady-kb/` first.\n- Run the tests before every push.\n'
      + '- Commit with conventional messages (`fix: …`, `feat: …`).\n- Ask before anything that costs money or deletes data.',
  },
  {
    scope: 'office', server: 'birch', title: 'Orchard: staging and releases', tags: ['release'],
    body: '# Staging and releases\n\nStaging is rebuilt from `main` every night at 2 AM.\n\n1. Merge to `main`\n2. Check staging\n3. Tag `vX.Y.Z` to release',
  },
  {
    scope: 'project', server: 'birch', project: 'app-backend', title: 'Payments: how a total is made', tags: ['payments', 'checkout'],
    body: '# How a total is made\n\n`PriceCalculator.total()` adds items, then the delivery fee, the service charge and the tip, then the discount.\n\n'
      + '| Part | Where |\n| --- | --- |\n| Items | `basket.ts` |\n| Fees | `fees.ts` |',
  },
  {
    scope: 'project', server: 'ash', project: 'harbor-web-app', title: 'دليل النصوص العربية', tags: ['rtl', 'copy'],
    body: '# دليل النصوص العربية\n\n- اكتب بالعربية الفصحى المبسطة.\n- الأرقام بالأرقام العربية الغربية (1، 2، 3).\n- تحقق من اتجاه الصفحة من اليمين إلى اليسار.',
  },
];

async function seedCards(hub: StepCSeedHub, meetingNote: string, typedNote: string): Promise<void> {
  for (const seed of cards(meetingNote, typedNote)) {
    const added = await hub.board.add({ source: 'web', ...seed.input }, 'owner');
    if (seed.link !== undefined) await hub.board.link(seed.link, [added.id]);
    if (seed.then !== undefined) {
      const note = seed.then.note?.replace('#10', `#${added.id}`);
      await hub.board.update(added.id, { ...seed.then, ...(note === undefined ? {} : { note }) }, 'hub');
    }
  }
}

/** True when it seeded; false when the database already had cards (a kept preview folder). */
export async function seedStepC(hub: StepCSeedHub): Promise<boolean> {
  if (hub.board.list().length > 0) return false;
  const meetingNote = seedMeeting(hub.db, hub.clock());
  const standUp = await hub.notes.create({
    title: 'Monday stand-up (typed)', project: 'app-backend',
    body: 'Yesterday: checkout fee bug found, release notes done.\nToday: fix the fee, look at the rider app crash.\nBlocked: the payments sandbox key expired.',
  });
  await hub.notes.create({ title: 'Ideas for the Harbor home page', body: 'Bigger search box. Arabic first. Show the three newest projects at the top.' });
  await seedCards(hub, meetingNote, standUp.id);
  for (const { pinned, ...page } of KB_PAGES) {
    const created = await hub.kb.create(page, 'owner');
    if (pinned === true) await hub.kb.update(created.id, { pinned: true }, 'owner');
  }
  return true;
}
