import type {
  SessionDTO, JiraIssueDTO, JiraIssueDetailDTO, JiraSiteDTO, KbPageFullDTO, LibraryDTO, LibraryProjectDTO, HostId, SkillDTO,
} from '@luady/shared';
import { iso, MINUTE } from '../office/data.js';

/** Library and Jira fixtures for the drawers demo page: what the hub answers for the Library and Jira pop-ups. */

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const proj = (server: HostId, name: string, over: Partial<LibraryProjectDTO> = {}): LibraryProjectDTO => ({
  server, path: `/home/dev/projects/${name}`, name, remote: `git@git.example:owner/${name}.git`, branch: 'main',
  commits: [{ hash: 'a1b2c3d4e5', date: iso(-3 * HOUR), subject: 'Tidy the error copy' }], stack: ['typescript'], updatedAt: iso(-HOUR),
  sessions: 0, openItems: 0, pages: 1, ...over,
});

const skill = (name: string, description: string, source: SkillDTO['source'] = 'user'): SkillDTO =>
  ({ name, description, source, path: `~/.claude/skills/${name}/SKILL.md` });

const SHARED_SKILLS: readonly SkillDTO[] = [
  skill('cc-prompt', 'Write a tight brief for a Claude Code session: goal, context, checklist, done-when.'),
  skill('code-review', 'Review the current diff for correctness bugs at a chosen effort level.', 'plugin'),
  skill('frontend-design', 'Distinctive, production-grade interfaces that avoid templated looks.', 'plugin'),
  skill('systematic-debugging', 'Find the root cause before proposing a fix.', 'plugin'),
];

export const LIBRARY: LibraryDTO = {
  offices: [
    {
      server: 'birch',
      projects: [
        proj('birch', 'orchard-backend', { branch: 'develop', stack: ['laravel', 'php', 'mysql'], sessions: 3, openItems: 4, pages: 3,
          commits: [{ hash: '9f3e1a2b7c', date: iso(-40 * MINUTE), subject: 'Menu import: stream the CSV instead of loading it' }] }),
        proj('birch', 'orchard-web', { stack: ['react', 'vite', 'tailwind'], sessions: 2, openItems: 2, pages: 2 }),
        proj('birch', 'dev_orchard-ios', { branch: 'release/4.2', stack: ['swift', 'swiftui'], sessions: 1, openItems: 1, pages: 1 }),
        proj('birch', 'orchard-android', { stack: ['kotlin', 'compose'], openItems: 1 }),
        proj('birch', 'orchard-payments', { stack: ['node', 'stripe'], sessions: 1, pages: 0 }),
      ],
      skills: [...SHARED_SKILLS, skill('laravel-boost', 'Laravel docs, artisan and database tools for this app.', 'project'),
        skill('orchard-release', 'Cut a release branch, bump versions, write the store notes.', 'project')],
      skillsAt: iso(-2 * HOUR),
    },
    {
      server: 'ash',
      projects: [proj('ash', 'harbor-web', { stack: ['next', 'react'], sessions: 1, openItems: 2 }), proj('ash', 'harbor-api', { stack: ['nest', 'postgres'], sessions: 1 }),
        proj('ash', 'harbor-admin', { pages: 0 })],
      skills: null,
      skillsAt: null,
    },
    {
      server: 'cedar',
      projects: [proj('cedar', 'meadow-vat', { stack: ['laravel', 'vue'], sessions: 1, openItems: 1, pages: 2 }), proj('cedar', 'meadow-api', { sessions: 1 }),
        proj('cedar', 'fitness-demo', { stack: ['flutter'], pages: 0 })],
      skills: [...SHARED_SKILLS.slice(0, 2), skill('vat-rules', 'VAT rules the MeadowVAT app follows.', 'project')],
      skillsAt: iso(-5 * HOUR),
    },
    { server: 'local', projects: [proj('local', 'client-sandbox', { stack: ['python'], pages: 0 })], skills: [skill('pictures', 'Make pictures with the GPT image route.')], skillsAt: iso(-DAY) },
  ],
  managerSkills: [skill('board', 'The board: cards, Run, Give to… and reports.', 'project'), skill('agency', 'The office, rooms and sessions.', 'project'),
    skill('cc-prompt', 'Write a tight brief for a session.', 'project'), skill('meetings', 'Wispr Flow notes and their action items.', 'project')],
};

let pageNo = 0;
const kb = (title: string, body: string, over: Partial<KbPageFullDTO> = {}): KbPageFullDTO => {
  pageNo += 1;
  return {
    id: pageNo, scope: 'global', server: null, project: null, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page',
    title, tags: [], pinned: false, auto: false, size: body.length, updatedAt: iso(-pageNo * 3 * HOUR), updatedBy: 'owner', body, ...over,
  };
};

const LONG = `# How we ship Orchard

Every change goes through **develop**, then a release branch. Never push to \`main\` by hand.

## Before a commit
- Run \`composer test\` and \`npm run test\`
- Check the menu import with the sample CSV in \`storage/samples\`
- Arabic strings live in \`lang/ar\`; keep them right-to-left

## Releases
1. Cut \`release/x.y\` from develop
2. Bump the app versions
3. Write the store notes (English and Arabic)

> The payments service has its own deploy. Ask before touching it.
`;

export const PAGES: readonly KbPageFullDTO[] = [
  kb('House rules', '# House rules\n\n- Small commits, clear messages.\n- Tests first.\n- Never print a secret.', { pinned: true, tags: ['rules'] }),
  kb('Who is who', 'Sara runs QA. Omar owns the iOS app. Luady briefs every session.', { tags: ['people'] }),
  kb('قواعد الكتابة بالعربية', 'اكتب الجمل قصيرة وواضحة.', { tags: ['arabic'] }),
  kb('Shipping Orchard', LONG, { scope: 'office', server: 'birch', pinned: true, tags: ['release', 'deploy'], updatedBy: 'manager' }),
  kb('Staging servers', 'Staging is `staging.orchard.example`. Data resets every Sunday.', { scope: 'office', server: 'birch' }),
  kb('Overview', '# orchard-backend\n\nLaravel 11, MySQL, queues on Redis.', { scope: 'project', server: 'birch', project: 'orchard-backend', auto: true, updatedBy: 'system' }),
  kb('Menu import', 'The importer streams the CSV in chunks of 500 rows.', { scope: 'project', server: 'birch', project: 'orchard-backend', tags: ['import'] }),
  kb('Queues', 'Horizon runs three queues: default, mail, import.', { scope: 'project', server: 'birch', project: 'orchard-backend' }),
  kb('Overview', '# orchard-web\n\nReact 19 with Vite.', { scope: 'project', server: 'birch', project: 'orchard-web', auto: true, updatedBy: 'system' }),
  kb('Harbor brand', 'Orange #f76707, green #37b24d. No gradients on buttons.', { scope: 'office', server: 'ash' }),
  kb('VAT rules', 'Standard rate 10%. Zero-rated exports need the export number.', { scope: 'office', server: 'cedar', tags: ['vat'] }),
  kb('Overview', '# meadow-vat\n\nLaravel and Vue.', { scope: 'project', server: 'cedar', project: 'meadow-vat', auto: true, updatedBy: 'system' }),
];

export const SYNCED_AT: Partial<Record<HostId, string | null>> = { birch: iso(-12 * MINUTE), ash: iso(-12 * MINUTE), cedar: iso(-3 * HOUR), local: null };

export const MEMORY = [
  { name: 'owner.md', content: '# The owner\n\nDeveloper. Short answers. Times as 3:20 PM.' },
  { name: 'servers.md', content: '# Servers\n\n- cedar: Meadow\n- birch: Orchard\n- ash: Harbor' },
];

export const SITE: JiraSiteDTO = {
  server: 'birch', baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', displayName: 'Owner', connectedAt: iso(-7 * DAY),
  lastOkAt: iso(-MINUTE), lastError: null, attention: 3,
};

const BASE = 'https://orchard-demo.atlassian.net/browse/';
type Cat = JiraIssueDTO['status']['category'];
const STATUS: Readonly<Record<string, Cat>> = { 'To Do': 'todo', 'In Progress': 'doing', 'In Review': 'doing', Done: 'done' };

const ticket = (n: number, summary: string, status: keyof typeof STATUS, over: Partial<JiraIssueDTO> = {}): JiraIssueDTO => ({
  key: `ORC-${String(n)}`, summary, type: 'Task', status: { name: status, category: STATUS[status] ?? 'todo' }, priority: 'Medium', labels: [],
  updatedAt: iso(-(n % 50) * 7 * MINUTE), sprint: 'Sprint 42 · Checkout', parent: null, flagged: false, hasNews: false, url: `${BASE}ORC-${String(n)}`, ...over,
});

export const ISSUES: readonly JiraIssueDTO[] = [
  ticket(1105, 'Checkout total skips the delivery fee when a coupon is applied', 'In Progress', { type: 'Bug', priority: 'Highest', hasNews: true, labels: ['checkout', 'web'] }),
  ticket(1121, 'Client preferences: remember the last delivery address', 'In Progress', { type: 'Story', labels: ['web'] }),
  ticket(1130, 'Menu import times out on files over 20 MB', 'To Do', { type: 'Bug', priority: 'High', flagged: true, labels: ['import'] }),
  ticket(1131, 'Add Arabic store notes for 4.2', 'To Do', { labels: ['release'] }),
  ticket(1134, 'Push notification copy for order ready', 'To Do', { type: 'Story', priority: 'Low' }),
  ticket(1136, 'iOS: crash when the cart is empty and the user taps pay', 'To Do', { type: 'Bug', priority: 'Highest', hasNews: true }),
  ticket(1138, 'Search index: rebuild nightly instead of hourly', 'To Do', { priority: 'Low' }),
  ticket(1112, 'Payments: retry a failed capture once', 'In Review', { type: 'Story', priority: 'High', hasNews: true }),
  ticket(1115, 'Android: dark mode colours on the order screen', 'In Review', { type: 'Bug' }),
  ticket(1098, 'Store desk: show the prep time per order', 'Done', { type: 'Story' }),
  ticket(1101, 'Remove the old promo banner', 'Done', { priority: 'Low' }),
  ticket(1110, 'Write the menu import sub-task tests', 'Done', { type: 'Sub-task', parent: { key: 'ORC-1130', summary: 'Menu import times out on files over 20 MB' } }),
];

const DESCRIPTION = `When a coupon is applied at checkout, the **total** shown to the customer leaves out the delivery fee. The order
that reaches the store has the right amount, so customers are charged more than they saw.

## Steps
1. Add two items from *Orchard Test Kitchen* to the cart
2. Apply the coupon \`WELCOME10\`
3. Choose delivery

**Expected:** total = items − coupon + delivery fee
**Actual:** total = items − coupon

## Notes
- Happens on web and iOS, not on Android
- Started after the 4.1.3 release, see the change in \`CheckoutSummary.tsx\`

| Platform | Seen |
| --- | --- |
| Web | yes |
| iOS | yes |
| Android | no |

> Customer support has 14 tickets about this since Thursday.

<script>alert('this must stay text')</script>`;

export function detailOf(issue: JiraIssueDTO): JiraIssueDetailDTO {
  const big = issue.key === 'ORC-1105';
  return {
    ...issue,
    descriptionMd: big ? DESCRIPTION : `${issue.summary}.\n\nSee the linked designs.`,
    reporter: big ? 'Sara Haddad' : 'Omar', assignee: 'Owner', createdAt: iso(-4 * DAY), dueDate: big ? new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10) : null,
    comments: big ? [
      { id: 'c1', author: 'Sara Haddad', at: iso(-2 * DAY), bodyMd: 'Seen on **iOS 17** too. Screenshot in the support ticket.' },
      { id: 'c2', author: 'Omar', at: iso(-1 * DAY), bodyMd: 'The iOS app reads the same `summary` endpoint, so one fix should cover both.' },
      { id: 'c3', author: 'Luady', at: iso(-3 * HOUR), bodyMd: 'A session on orchard-web is on it: `checkout-fee`.' },
    ] : [],
    transitions: [
      { id: '11', name: 'To Do', to: 'To Do' }, { id: '21', name: 'Start progress', to: 'In Progress' },
      { id: '31', name: 'Send to review', to: 'In Review' }, { id: '41', name: 'Done', to: 'Done' },
    ].filter((t) => t.to !== issue.status.name),
    subtasks: big ? [{ key: 'ORC-1106', summary: 'Add a test for coupon + delivery', status: 'To Do' }, { key: 'ORC-1107', summary: 'Fix the iOS summary view', status: 'In Progress' }] : [],
  };
}

export const STATUS_OF = STATUS;

const projectSession = (name: string, cwd: string, state: SessionDTO['state']): SessionDTO => ({
  id: `birch:${name}:0.0`, host: 'birch', target: `${name}:0.0`, claudeSessionId: null, cwd: `/home/dev/projects/${cwd}`, project: cwd,
  displayName: name, state, origin: 'manager', registered: true, lastEventAt: iso(-MINUTE), turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
});

/** Sessions in the Library's project folders (orchard-backend has three, as its counts say). */
export const PROJECT_SESSIONS: readonly SessionDTO[] = [
  projectSession('menu-import', 'orchard-backend', 'working'),
  projectSession('queue-tidy', 'orchard-backend', 'idle'),
  projectSession('api-review', 'orchard-backend', 'waiting_question'),
  projectSession('checkout-fee', 'orchard-web', 'working'),
];
