// The pictures of a new install: the setup wizard's four screens, then Settings with no servers, and the Add a server
// dialog's first two steps.
import { addVirtualPasskey, newPage, pageSettled, routeHttpsToHub } from './browser.mjs';
import { DEMO_PIN } from './demo.mjs';
import { PICTURES, savePng } from './pictures.mjs';

/** The made-up server the Add a server pictures add (the demo resolves only names under .invalid). */
const NEW_SERVER = Object.freeze({ address: 'oak.example.invalid', name: 'oak', user: 'dev' });
/**
 * A new install has no time zone yet: the claim stores the browser's. The first-run pictures use UTC, so the wizard
 * says "Times are shown in UTC" (the office pictures keep the demo's own zone, see browser.mjs).
 */
const FIRST_RUN_ZONE = 'UTC';
/**
 * The setup wizard pictures: 880 pixels wide from the top of the page (its header, step list and card), 8 pixels down
 * as in the earlier pictures, as tall as pictures.mjs says. The window is taller, so the page never scrolls to show a
 * step.
 */
const SETUP_VIEW = Object.freeze({ width: 880, height: 900 });
const SETUP_TOP = 8;
/** The steps whose card is shown whole, with this much of the page under it (the long Claim and Rooms cards go on). */
const WHOLE_CARD = Object.freeze(['setup-pin.png', 'setup-open.png']);
const UNDER_CARD = 38;
const DESKTOP_VIEW = Object.freeze({ width: 1440, height: 900 });

async function setupShot(ctx, page, name) {
  if (!ctx.want(name)) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await pageSettled(page);
  const [width, height] = PICTURES[name];
  if (WHOLE_CARD.includes(name)) {
    const card = await page.locator('.setup-card').boundingBox();
    const needs = Math.round(card.y + card.height + UNDER_CARD - SETUP_TOP);
    if (needs !== height) console.warn(`  ${name}: its card wants a picture ${needs} pixels high, pictures.mjs says ${height}`);
  }
  await savePng(ctx, name, await page.screenshot({ clip: { x: 0, y: SETUP_TOP, width, height } }));
}

/** Claim with the code and a passkey, the PIN, rooms and connect skipped, extras as they are, open the office. */
async function walkTheWizard(ctx, page) {
  await page.goto(`${ctx.base}/`);
  await page.getByTestId('setup-claim').waitFor();
  await setupShot(ctx, page, 'setup-claim.png');
  await page.getByTestId('setup-code-input').fill(ctx.preview.app.services.setupCodes.issue('owner_setup'));
  await page.getByTestId('setup-passkey-button').click();
  await page.getByTestId('setup-pin').waitFor();
  await setupShot(ctx, page, 'setup-pin.png');
  await page.getByTestId('pin-new-input').fill(DEMO_PIN);
  await page.getByTestId('pin-confirm-input').fill(DEMO_PIN);
  await page.getByTestId('pin-save-button').click();
  await page.getByTestId('setup-rooms').waitFor();
  await setupShot(ctx, page, 'setup-rooms.png');
  await page.getByTestId('rooms-step').getByRole('button', { name: 'Skip for now' }).click();
  await page.getByTestId('setup-connect').getByTestId('setup-skip').click();
  await page.getByTestId('setup-extras').getByTestId('setup-next').click();
  await page.getByTestId('setup-open').waitFor();
  await page.getByTestId('setup-summary').getByText('Manager: off').waitFor();
  await setupShot(ctx, page, 'setup-open.png');
  await page.getByTestId('setup-finish').click();
  await page.getByTestId('agency-page').or(page.getByTestId('nav-inbox')).first().waitFor({ timeout: 60_000 });
}

/** How far below the bottom of the window the "Notifications and schedule" card starts in settings.png. */
const BELOW_WINDOW = 8;

/**
 * Settings, scrolled so that the "Notifications and schedule" card starts just below the window: the General card ends
 * in view with its own Save bar, and no sticky save bar lies over a field. The Servers card, which the caption is
 * about, must be wholly in view on the right.
 */
async function settingsShot(ctx, page) {
  await page.setViewportSize(DESKTOP_VIEW);
  await page.goto(`${ctx.base}/settings`);
  await page.getByTestId('hosts-section').getByText('No servers yet. Add one, or this computer.').waitFor();
  const notifications = page.getByRole('region', { name: 'Notifications and schedule' });
  await notifications.evaluate((card, below) => {
    let box = document.scrollingElement;
    for (let el = card.parentElement; el !== null; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) {
        box = el;
        break;
      }
    }
    box.scrollTop += card.getBoundingClientRect().top - (window.innerHeight + below);
  }, BELOW_WINDOW);
  await pageSettled(page);
  const below = await notifications.boundingBox();
  const servers = await page.getByRole('region', { name: 'Servers' }).boundingBox();
  if (below.y < DESKTOP_VIEW.height) throw new Error('settings.png: the page could not scroll far enough; a sticky save bar would show');
  if (servers.y < 0 || servers.y + servers.height > DESKTOP_VIEW.height) throw new Error('settings.png: the Servers card is not wholly in view');
  if (ctx.want('settings.png')) await savePng(ctx, 'settings.png', await page.screenshot());
}

/** How far a dialog may differ from its picture's size and still be framed at that size (a dialog's edges fall between pixels). */
const DIALOG_SLACK = 3;

/**
 * One dialog as it sits on the page, with about a pixel of the page around it (its rounded corners), centred in a
 * frame of the picture's size. A dialog that grew or shrank by more than a few pixels gets a frame of its own size
 * instead (and savePng says so).
 */
async function dialogShot(ctx, page, dialog, name) {
  if (!ctx.want(name)) return;
  await pageSettled(page);
  const box = await dialog.boundingBox();
  if (box === null) throw new Error(`${name}: the dialog is not on screen`);
  const [wantWidth, wantHeight] = PICTURES[name];
  const fits = (have, want) => Math.abs(have + 2 - want) <= DIALOG_SLACK;
  const width = fits(box.width, wantWidth) ? wantWidth : Math.round(box.width) + 2;
  const height = fits(box.height, wantHeight) ? wantHeight : Math.round(box.height) + 2;
  const clip = { x: Math.round(box.x + box.width / 2 - width / 2), y: Math.round(box.y + box.height / 2 - height / 2), width, height };
  await savePng(ctx, name, await page.screenshot({ clip }));
}

/** Settings → Servers → Add a server: the details, then (after the PIN that "Save and go on" asks for) the key line. */
async function addServerShots(ctx, page) {
  await page.getByTestId('hosts-section').getByRole('button', { name: 'Add a server' }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('add-server-flow') });
  const details = dialog.getByTestId('host-step-details');
  await details.getByLabel('Address').fill(NEW_SERVER.address);
  await details.getByLabel('Name').fill(NEW_SERVER.name);
  await details.getByLabel('User').fill(NEW_SERVER.user);
  await dialogShot(ctx, page, dialog, 'add-server-details.png');
  await dialog.getByRole('button', { name: 'Save and go on' }).click();
  const prompt = page.getByRole('dialog').filter({ hasText: 'Confirm with your PIN' });
  await prompt.getByLabel('PIN', { exact: true }).waitFor();
  await prompt.getByLabel('PIN', { exact: true }).fill(DEMO_PIN);
  await prompt.getByLabel('PIN', { exact: true }).press('Enter');
  await dialog.getByTestId('host-paste-line').waitFor();
  await prompt.waitFor({ state: 'detached' });
  await dialogShot(ctx, page, dialog, 'add-server-key-line.png');
}

/** Every new-install picture, in the order a new owner sees them. */
export async function firstRunPictures(ctx) {
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, zone: FIRST_RUN_ZONE, ...SETUP_VIEW });
  try {
    await routeHttpsToHub(page, ctx.preview.port, ctx.WebSocket);
    await addVirtualPasskey(page);
    await walkTheWizard(ctx, page);
    await settingsShot(ctx, page);
    await addServerShots(ctx, page);
  } catch (err) {
    await ctx.debugShot(page, 'first-run');
    throw err;
  } finally {
    await context.close();
  }
}
