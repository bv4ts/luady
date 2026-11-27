/** The fake Jira site's tickets: a sprint "Sprint 42 · Checkout" on the Orchard project, in Jira's document format. */

export type JiraStatus = 'To Do' | 'In Progress' | 'In Review' | 'Done';

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }[];
  readonly content?: readonly AdfNode[];
}
export interface AdfDoc { readonly type: 'doc'; readonly version: 1; readonly content: readonly AdfNode[] }

export interface FakeComment { readonly id: string; readonly author: string; readonly createdMs: number; readonly body: AdfDoc }

export interface FakeTicket {
  readonly key: string;
  readonly summary: string;
  readonly type: 'Bug' | 'Story' | 'Task' | 'Epic' | 'Sub-task';
  readonly status: JiraStatus;
  readonly priority: 'Highest' | 'High' | 'Medium' | 'Low';
  readonly labels: readonly string[];
  /** Minutes before the preview started. */
  readonly ageMin: number;
  readonly inSprint: boolean;
  readonly flagged: boolean;
  readonly mine: boolean;
  readonly parent: string | null;
  readonly subtasks: readonly string[];
  readonly dueInDays: number | null;
  readonly description: AdfDoc;
  readonly comments: readonly FakeComment[];
}

export const STATUS_CATEGORY: Readonly<Record<JiraStatus, 'new' | 'indeterminate' | 'done'>> = {
  'To Do': 'new', 'In Progress': 'indeterminate', 'In Review': 'indeterminate', Done: 'done',
};

/** Every status can be reached from every other one, like a simple team-managed workflow. */
export const TRANSITIONS: readonly { readonly id: string; readonly name: string; readonly to: JiraStatus }[] = [
  { id: '11', name: 'Back to To Do', to: 'To Do' },
  { id: '21', name: 'Start progress', to: 'In Progress' },
  { id: '31', name: 'Ready for review', to: 'In Review' },
  { id: '41', name: 'Done', to: 'Done' },
];

export const SPRINT = { id: 42, name: 'Sprint 42 · Checkout', state: 'active', daysLeft: 5, startedDaysAgo: 9 } as const;

const text = (value: string, marks?: AdfNode['marks']): AdfNode => (marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks });
const bold = (value: string): AdfNode => text(value, [{ type: 'strong' }]);
const code = (value: string): AdfNode => text(value, [{ type: 'code' }]);
const para = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const heading = (value: string): AdfNode => ({ type: 'heading', attrs: { level: 3 }, content: [text(value)] });
const bullets = (...items: string[]): AdfNode => ({
  type: 'bulletList', content: items.map((item) => ({ type: 'listItem', content: [para(text(item))] })),
});
const codeBlock = (language: string, value: string): AdfNode => ({ type: 'codeBlock', attrs: { language }, content: [text(value)] });
const mention = (name: string): AdfNode => ({ type: 'mention', attrs: { id: `preview-${name.toLowerCase()}`, text: `@${name}` } });
export const doc = (...content: AdfNode[]): AdfDoc => ({ type: 'doc', version: 1, content });

/** A plain description: what is wrong, how to see it, and when it is done. */
function story(what: string, steps: readonly string[], done: string): AdfDoc {
  return doc(para(text(what)), heading('How to see it'), bullets(...steps), heading('Done when'), para(text(done)));
}

const MIN = 60_000;
const comment = (id: string, author: string, agoMin: number, ...content: AdfNode[]): FakeComment => ({
  id, author, createdMs: -agoMin * MIN, body: doc(...content),
});

const base = {
  labels: [] as readonly string[], inSprint: true, flagged: false, mine: true, parent: null, subtasks: [] as readonly string[],
  dueInDays: null, comments: [] as readonly FakeComment[],
};

export const TICKETS: readonly FakeTicket[] = [
  {
    ...base, key: 'ORC-1101', summary: 'Checkout total ignores the delivery fee', type: 'Bug', status: 'In Progress', priority: 'High',
    labels: ['checkout', 'payments'], ageMin: 35, flagged: true, parent: 'ORC-1090', dueInDays: 2,
    description: doc(
      para(text('The total on the last checkout step is the basket only. The '), bold('delivery fee'), text(' is shown but never added.')),
      heading('How to see it'),
      bullets('Add any two items from a restaurant with a delivery fee', 'Go to checkout and pick card payment', 'Compare the total with the receipt e-mail'),
      para(text('The sum is made in '), code('PriceCalculator.total()'), text(':')),
      codeBlock('ts', 'return items.reduce((sum, item) => sum + item.price * item.quantity, 0);'),
      heading('Done when'),
      para(text('The total includes the fee and the service charge, with a test for each.')),
    ),
    comments: [
      comment('10001', 'Sara Haddad', 300, para(text('Seen on iOS and Android. It started with the 4.12 release.'))),
      comment('10002', 'Omar Khalil', 90, para(mention('Owner'), text(' this blocks the promo campaign on Thursday. Can we get it in today?'))),
    ],
  },
  {
    ...base, key: 'ORC-1105', summary: 'Apple Pay sheet shows the wrong merchant name', type: 'Bug', status: 'To Do', priority: 'Medium',
    labels: ['ios', 'payments'], ageMin: 600,
    description: story('The Apple Pay sheet says "ORCHARD TEST" instead of "Orchard".',
      ['Pay with Apple Pay on a release build', 'Look at the merchant line on the sheet'], 'The sheet shows "Orchard" on release builds.'),
  },
  {
    ...base, key: 'ORC-1108', summary: 'Promo code field accepts expired codes', type: 'Bug', status: 'To Do', priority: 'Highest',
    labels: ['checkout', 'promo'], ageMin: 120, flagged: true, parent: 'ORC-1090', dueInDays: 1,
    description: story('An expired promo code is accepted and the discount is applied.',
      ['Enter the code SPRING25 (expired last month)', 'The discount appears in the order summary'],
      'Expired codes are refused with "This code has expired."'),
    comments: [comment('10003', 'Omar Khalil', 60, para(text('Finance flagged this: 41 orders used expired codes yesterday.')))],
  },
  {
    ...base, key: 'ORC-1112', summary: 'Saved cards list for returning customers', type: 'Story', status: 'In Progress', priority: 'Medium',
    labels: ['checkout'], ageMin: 200, parent: 'ORC-1090', subtasks: ['ORC-1113', 'ORC-1114'],
    description: story('Returning customers see their saved cards first and can pay with one tap.',
      ['Sign in with a customer who paid before', 'Open checkout'], 'Saved cards show with the last four digits; the newest is selected.'),
  },
  {
    ...base, key: 'ORC-1115', summary: 'Order summary in Arabic is cut off', type: 'Bug', status: 'In Review', priority: 'Medium',
    labels: ['rtl', 'checkout'], ageMin: 400,
    description: doc(
      para(text('In Arabic the order summary loses its last line on small phones:')),
      para(text('ملخص الطلب لا يظهر كاملاً على الشاشات الصغيرة')),
      bullets('Switch the app to Arabic', 'Open checkout on an iPhone SE'),
    ),
    comments: [comment('10004', 'Sara Haddad', 240, para(text('Fix is on the branch rtl-summary, ready for a look.')))],
  },
  {
    ...base, key: 'ORC-1117', summary: 'Retry a failed payment without losing the cart', type: 'Story', status: 'To Do', priority: 'High',
    labels: ['payments'], ageMin: 1_500, parent: 'ORC-1090',
    description: story('When a card payment fails the cart is emptied and the customer starts again.',
      ['Pay with the test card 4000 0000 0000 0002 (declined)'], 'The cart stays and a "Try again" button pays with another method.'),
  },
  {
    ...base, key: 'ORC-1120', summary: 'Track checkout steps in analytics', type: 'Task', status: 'Done', priority: 'Low', ageMin: 2_900,
    description: story('Send one analytics event per checkout step.', ['Open the analytics debug view'], 'Every step sends checkout_step with its number.'),
  },
  {
    ...base, key: 'ORC-1121', summary: 'Tip selector for the rider', type: 'Story', status: 'In Review', priority: 'Medium',
    labels: ['checkout'], ageMin: 700,
    description: story('Customers can add a tip of 2, 5 or 10 in their local currency, or their own amount.', ['Open checkout'], 'The tip is added to the total and to the receipt.'),
  },
  {
    ...base, key: 'ORC-1123', summary: 'Push notification when the order is accepted', type: 'Task', status: 'Done', priority: 'Medium',
    labels: ['notifications'], ageMin: 3_100,
    description: story('Send a push notification when the restaurant accepts the order.', ['Place an order on staging'], 'The push arrives within 5 seconds.'),
  },
  {
    ...base, key: 'ORC-1126', summary: 'Cash on delivery limit per area', type: 'Story', status: 'To Do', priority: 'Medium', ageMin: 2_200,
    description: story('Each delivery area has its own cash on delivery limit.', ['Open the admin areas page'], 'Above the limit, cash is not offered.'),
  },
  {
    ...base, key: 'ORC-1128', summary: 'Unit tests for the price calculator', type: 'Task', status: 'In Progress', priority: 'Low',
    labels: ['tests'], ageMin: 800,
    description: story('The price calculator has no tests for fees, tips and discounts.', ['Run npm test in app-backend'], 'Coverage of PriceCalculator is above 90%.'),
  },
  {
    ...base, key: 'ORC-1130', summary: 'Delivery slot picker skips today after 6 PM', type: 'Bug', status: 'To Do', priority: 'High',
    labels: ['checkout'], ageMin: 50, dueInDays: 3,
    description: story('After 6 PM the slot picker starts with tomorrow, even when today still has slots until 11 PM.',
      ['Open checkout after 6 PM owner time'], 'Today\'s remaining slots show first.'),
  },
  {
    ...base, key: 'ORC-1098', summary: 'Menu import drops item photos', type: 'Bug', status: 'To Do', priority: 'Medium', inSprint: false,
    labels: ['menu-import'], ageMin: 5_000,
    description: story('Photos are missing after a menu import from the restaurant spreadsheet.', ['Import the sample menu on staging'], 'Every item keeps its photo.'),
  },
  {
    ...base, key: 'ORC-1131', summary: 'Rider app crashes on Android 15', type: 'Bug', status: 'To Do', priority: 'High', mine: false, ageMin: 30,
    description: story('Someone else\'s ticket: never on the owner\'s board.', ['Open the rider app'], 'No crash.'),
  },
];

/** Parents and sub-tasks the tickets point at (not on the board themselves). */
export const RELATED: Readonly<Record<string, { readonly summary: string; readonly status: JiraStatus }>> = {
  'ORC-1090': { summary: 'Checkout v2', status: 'In Progress' },
  'ORC-1113': { summary: 'Saved cards API', status: 'Done' },
  'ORC-1114': { summary: 'Saved cards screen', status: 'In Progress' },
};
