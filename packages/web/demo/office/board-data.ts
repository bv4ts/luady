import type { BoardEventDTO, BoardItemDTO, ChatMessageDTO, MissionDTO, NoteDTO } from '@luady/shared';
import { MINUTE, iso } from './data.js';

/** Board and notes fixtures for the office demo: cards in every lane, Luady's missions, two notes and a meeting. */

const HOUR = 60 * MINUTE;
const card = (id: number, title: string, over: Partial<BoardItemDTO> = {}): BoardItemDTO => ({
  id, title, details: '', project: null, server: null, source: 'web', sourceRef: null, state: 'open', today: false, priority: 0,
  auto: false, runId: null, sessionId: null, result: null, createdAt: iso(-id * 37 * MINUTE), updatedAt: iso(-id * 11 * MINUTE),
  doneAt: null, dueAt: null, snoozeUntil: null, ...over,
});

export const CARDS: readonly BoardItemDTO[] = [
  card(31, 'Ship the new checkout coupon flow', {
    project: 'orchard-web', server: 'birch', today: true, priority: 1, source: 'meeting', sourceRef: 'm:standup-1114',
    details: 'From Thursday\'s stand-up.\n\n- Coupon field on the checkout page\n- Validate against `/api/coupons`\n- Show the saving in the summary',
  }),
  card(30, 'Reply to the Harbor store review on the Arabic copy', { project: 'harbor-web', server: 'ash', today: true }),
  card(29, 'Rotate the staging database password', { server: 'cedar', priority: 1 }),
  card(28, 'ORC-1182 Push notifications open the wrong screen', { project: 'app-backend', server: 'birch', source: 'jira', sourceRef: 'birch:ORC-1182' }),
  card(27, 'تحديث نص صفحة الأسعار', { project: 'harbor-web', server: 'ash', source: 'chat' }),
  card(26, 'Look into the slow admin reports page', { project: 'meadow-admin', server: 'cedar', source: 'manager' }),
  card(25, 'Buy a domain for the private side project'),
  card(24, 'Payroll export uses ISO dates', {
    project: 'app-backend', server: 'birch', state: 'running', source: 'manager', auto: true, sessionId: 'birch:app-backend:0.0', runId: 'r_demo_1',
    details: 'Finance asked for ISO dates in the payroll CSV so their importer stops guessing the month.',
  }),
  card(23, 'Client preferences: save the delivery window', { project: 'client-preferences', server: 'birch', state: 'running', sessionId: 'birch:client-preferences:0.0', runId: 'r_demo_1' }),
  card(22, 'Meadow VAT: quarterly return PDF', { project: 'meadow-vat', server: 'cedar', state: 'running', sessionId: 'cedar:meadow-vat:0.0', runId: 'r_demo_2' }),
  card(21, 'Harbor landing page hero copy', { project: 'harbor-web', server: 'ash', state: 'queued', runId: 'r_demo_3' }),
  card(20, 'Ticket ORC-1105: refund button stays disabled', { project: 'jira-1105', server: 'birch', state: 'running', sessionId: 'birch:jira-1105:0.0', source: 'jira', sourceRef: 'birch:ORC-1105' }),
  card(19, 'Meadow API: migrate the audit table', { project: 'meadow-api', server: 'cedar', state: 'running', sessionId: 'cedar:meadow-api:0.0' }),
  card(18, 'Store desk: printer queue keeps stalling', {
    project: 'store-desk', server: 'birch', state: 'review', sessionId: 'birch:store-desk:0.0',
    result: 'Blocked: the printer driver needs a vendor login I do not have.',
  }),
  card(17, 'Translate the onboarding emails', { state: 'review', result: 'No project given. Which office is this for?' }),
  card(16, 'Fix the flaky login test', {
    project: 'orchard-web', server: 'birch', state: 'done', result: 'The test waited on a fixed timer; it now waits for the session cookie.', doneAt: iso(-2 * HOUR),
  }),
  card(15, 'Upgrade the mobile app to the new SDK', { project: 'app-backend', server: 'birch', state: 'done', result: 'Upgraded, 214 tests pass.', doneAt: iso(-26 * HOUR) }),
  card(14, 'Harbor sitemap for the new pages', { project: 'harbor-web', server: 'ash', state: 'done', result: 'Sitemap submitted.', doneAt: iso(-3 * 24 * HOUR) }),
  card(13, 'Water the office plant', { state: 'open', snoozeUntil: iso(48 * HOUR) }),
];

export const MISSIONS: readonly MissionDTO[] = [
  {
    sessionId: 'birch:app-backend:0.0', label: 'birch · app-backend', title: 'Payroll export uses ISO dates', phase: 'working', turns: 4,
    note: 'Change the date format in export.ts and csv.ts, then run the payroll tests.',
    lastText: 'Both files now write **YYYY-MM-DD**. Running `npm test -- payroll` next; 38 of 41 pass so far.', openedAt: iso(-40 * MINUTE), idleSince: null,
  },
  {
    sessionId: 'birch:client-preferences:0.0', label: 'birch · client-preferences', title: 'Delivery window', phase: 'working', turns: 2,
    note: 'Add the window to the preferences form and the API.', lastText: null, openedAt: iso(-30 * MINUTE), idleSince: null,
  },
  {
    sessionId: 'cedar:meadow-vat:0.0', label: 'cedar · meadow-vat', title: 'Quarterly return PDF', phase: 'working', turns: 6,
    note: 'Generate the return as a PDF from the existing HTML report.', lastText: 'The PDF renders; fixing the Arabic font next.', openedAt: iso(-90 * MINUTE), idleSince: null,
  },
];

const event = (id: number, itemId: number, minutesAgo: number, kind: BoardEventDTO['kind'], text: string): BoardEventDTO =>
  ({ id, itemId, at: iso(-minutesAgo * MINUTE), kind, text });

export const EVENTS: Readonly<Record<number, readonly BoardEventDTO[]>> = {
  24: [
    event(101, 24, 40, 'created', 'Luady opened a mission for this.'),
    event(102, 24, 39, 'started', 'birch · app-backend took it.'),
    event(103, 24, 22, 'report', 'export.ts writes ISO dates.'),
    event(104, 24, 9, 'report', 'csv.ts done; running the tests.'),
  ],
  18: [
    event(111, 18, 120, 'created', 'Added on the website.'),
    event(112, 18, 90, 'started', 'birch · store-desk took it.'),
    event(113, 18, 30, 'blocked', 'The printer driver needs a vendor login I do not have.'),
  ],
  31: [event(121, 31, 26 * 60, 'created', 'Added by Luady from the stand-up note.')],
};

export const NOTES: readonly NoteDTO[] = [
  {
    id: 'n:7', kind: 'note', title: 'Stand-up, Thursday', at: iso(-3 * HOUR), project: 'orchard-web', people: null, gist: null,
    summary: 'Yesterday: coupons half done, login test still flaky.\nToday: finish coupons, look at the push notification bug.\nBlocked: printer at the store desk.',
    actionItems: '- Finish the coupon field on checkout\n- Find out why push notifications open the wrong screen\n- Ask the vendor for the printer login',
    ownerNotes: null, link: null, hasTranscript: false, editable: true,
  },
  {
    id: 'm:standup-1114', kind: 'meeting', title: 'Weekly sync with Orchard', at: iso(-26 * HOUR), project: 'orchard-web',
    people: 'the owner, Lina, Omar', gist: 'Coupons ship Sunday; the payroll CSV needs ISO dates.',
    summary: 'The team agreed to ship the coupon flow on Sunday. Finance reported that the payroll export confuses months and days; Omar asked for ISO dates. Lina will check the store-desk printer.',
    actionItems: '1. Ship the checkout coupon flow by Sunday\n2. Payroll export uses ISO dates\n3. Lina checks the store-desk printer',
    ownerNotes: 'Remember to ask about the holiday menu.', link: 'https://wisprflow.ai/notes/standup-1114', hasTranscript: true, editable: false,
    isNew: true,
  },
  {
    id: 'n:6', kind: 'note', title: 'Harbor ideas', at: iso(-3 * 24 * HOUR), project: 'harbor-web', people: null, gist: null,
    summary: 'A bilingual hero, prices in local currency, and a short video on the landing page.', actionItems: null, ownerNotes: null, link: null,
    hasTranscript: false, editable: true,
  },
  {
    id: 'm:meadow-1110', kind: 'meeting', title: 'Meadow planning', at: iso(-5 * 24 * HOUR), project: 'meadow-api', people: 'the owner, Sami',
    gist: 'Audit table migration first, then the reports page.', summary: 'Sami wants the audit table migrated before the new reports.', actionItems: '- Migrate the audit table\n- Speed up the admin reports page',
    ownerNotes: null, link: null, hasTranscript: true, editable: false,
  },
];

export const TRANSCRIPT_PARTS: readonly string[] = [
  'Owner: Morning all. Coupons first?\nLina: The field is in, validation is half done.\nOmar: Finance keeps asking about the payroll CSV. The months and days get swapped in their importer.\n',
  'Owner: Then ISO dates, year first. Luady can take that today.\nLina: I will look at the store printer again, it stalled twice yesterday.\nOwner: Sunday for coupons then.\n',
];

/** Luady's chat: the owner sent the stand-up note for discussion and Luady answered. */
export const NOTE_CHAT: readonly ChatMessageDTO[] = [
  {
    id: 'm_demo_note_1', thread: 'manager', role: 'owner', channel: 'web', text: 'Here is today\'s stand-up, what do you think?', ts: iso(-170 * MINUTE),
    about: { kind: 'note', id: 'n:7', label: 'Stand-up, Thursday' },
  },
  {
    id: 'm_demo_note_2', thread: 'manager', role: 'manager', channel: 'web', ts: iso(-168 * MINUTE),
    text: 'Coupons are the one thing that has to ship, so I put **Ship the new checkout coupon flow** on the board for today. The push bug is ORC-1182; I added it from Jira. The printer needs a vendor login only you can get, so that one waits for you.',
  },
];
