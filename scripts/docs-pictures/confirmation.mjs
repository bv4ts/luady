// pin-confirm.png: a PIN confirmation in the Inbox. The manager wants to send a short message to a session in Cedar;
// outside the owner's own turn that waits for the owner's PIN, and the card shows the message's size, line count,
// SHA-256 and first lines.
import { newPage, pageSettled } from './browser.mjs';
import { savePng } from './pictures.mjs';

/** What the manager would send: short, harmless, two lines, so the card has first lines to show. */
const MANAGER_MESSAGE = 'Please run the unit tests again.\nIf one fails, tell me which one and why; do not change any code yet.';
/** The session it goes to: meadow-hr on the server cedar, in the room Cedar. */
const TO = Object.freeze({ host: 'cedar', name: 'meadow-hr' });
/** The card's width in the picture (the earlier picture's), with a pixel of the page on each side. */
const CARD_WIDTH = 448;
const FIRST_VIEW = Object.freeze({ width: 480, height: 900 });

/**
 * Asks for the send the way the manager's session_send tool does (the hub's action service, actor "manager", channel
 * "event"): outside the owner's turn it is not run, it waits for the PIN.
 */
async function askAsManager(preview) {
  const session = preview.app.services.sessions.list()
    .find((s) => s.host === TO.host && (s.displayName === TO.name || s.target.startsWith(`${TO.name}:`)));
  if (session === undefined) throw new Error(`no session ${TO.name} on ${TO.host}`);
  const action = await preview.app.services.actions.request({
    kind: 'session.send', actor: 'manager', channel: 'event', params: { sessionId: session.id, text: MANAGER_MESSAGE },
  });
  if (action.status !== 'pending_confirmation') throw new Error(`the send did not wait for the PIN (${action.status})`);
  return action;
}

/** The card for one action, as it stands on the Inbox page. */
const cardOf = (page, id) => page.locator(`[data-testid="action-card"][data-action-id="${id}"]`);

/** The Inbox at a width where the card is CARD_WIDTH wide (the page's margins are measured, not assumed). */
async function inboxAtCardWidth(page, base, id) {
  await page.goto(`${base}/inbox`);
  const card = cardOf(page, id);
  await card.waitFor();
  const first = await card.boundingBox();
  await page.setViewportSize({ width: Math.round(FIRST_VIEW.width + CARD_WIDTH - first.width), height: FIRST_VIEW.height });
  await pageSettled(page);
  const box = await card.boundingBox();
  if (Math.abs(box.width - CARD_WIDTH) > 0.5) throw new Error(`the card came out ${box.width} wide, not ${CARD_WIDTH}`);
  return card;
}

export async function pinConfirmShot(ctx) {
  if (!ctx.want('pin-confirm.png')) return;
  const action = await askAsManager(ctx.preview);
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...FIRST_VIEW, storageState: ctx.storageState });
  try {
    const card = await inboxAtCardWidth(page, ctx.base, action.id);
    await card.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await pageSettled(page);
    const box = await card.boundingBox();
    const clip = { x: Math.round(box.x) - 1, y: Math.round(box.y) - 1, width: CARD_WIDTH + 2, height: Math.round(box.height) + 2 };
    await savePng(ctx, 'pin-confirm.png', await page.screenshot({ clip }));
  } finally {
    await context.close();
    await ctx.preview.app.services.actions.deny(action.id, 'web');
  }
}
