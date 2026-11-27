// The office with its three rooms: the whole office, the Rooms menu, the whole office at 800 x 500 for the card, and
// a close-up of the manager at HQ.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newPage, officeSettled, pageApi, pageSettled, areaShot } from './browser.mjs';
import { DESKTOP_VIEW } from './office.mjs';
import { savePng } from './pictures.mjs';

/** The top bar and the chat line over the stage (packages/web/src/features/agency/panels/insets.ts). */
const TOP_BAR_PX = 56;
const CHAT_LINE_PX = 64;
/** In the close-up, each pixel of the map is this many pixels of the picture. */
const CLOSE_UP_PIXEL = 2;

async function freshOffice(page, base) {
  await page.goto(`${base}/`);
  await page.getByTestId('agency-page').waitFor({ timeout: 60_000 });
  await officeSettled(page);
  await pageSettled(page);
}

/**
 * feature-servers.png: the same view as office.png, drawn by the browser at 800 x 500 (a device scale of 800/1440),
 * so no picture is scaled afterwards.
 */
async function wholeOfficeCard(ctx) {
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...DESKTOP_VIEW, scale: 800 / DESKTOP_VIEW.width, storageState: ctx.storageState });
  try {
    await freshOffice(page, ctx.base);
    await savePng(ctx, 'feature-servers.png', await page.screenshot());
  } finally {
    await context.close();
  }
}

/**
 * The zoom of the whole-office view on a wide screen, computed as the website computes it (camera-math.ts,
 * wholeOfficeFit): the building of these rooms (@luady/office buildOffice) fitted between the top bar and the chat line.
 */
async function wholeOfficeZoom(ctx, page, view) {
  const office = await import(pathToFileURL(join(ctx.repoRoot, 'packages', 'office', 'dist', 'index.js')).href);
  const rooms = (await pageApi(page, 'GET', '/api/rooms')).items;
  const building = office.buildOffice(rooms).zones.all;
  const free = { width: view.width, height: view.height - TOP_BAR_PX - CHAT_LINE_PX };
  if (free.width / free.height < 1.25) throw new Error('the close-up needs a wide screen');
  return Math.min(free.width / building.w, free.height / building.h);
}

/**
 * feature-manager.png: HQ's middle in the whole-office view, 800 x 500 around the manager's desk. The page is drawn at
 * the device scale that makes each map pixel exactly 2 x 2 picture pixels at that view's zoom, so the pixel art stays
 * crisp and the name plate is as large as on a high-density screen.
 */
async function managerCloseUp(ctx, page) {
  const zoom = await wholeOfficeZoom(ctx, page, DESKTOP_VIEW);
  // A hair under 2: the website draws crisp when zoom x scale is within a millionth of a whole number, and a rounding
  // just over 2 would make it draw 3 pixels per map pixel and smooth them down.
  const scale = (CLOSE_UP_PIXEL - 5e-7) / zoom;
  const { context, page: close } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...DESKTOP_VIEW, scale, storageState: ctx.storageState });
  try {
    await freshOffice(close, ctx.base);
    const ratio = await close.evaluate(() => window.devicePixelRatio);
    if (Math.abs(ratio * zoom - CLOSE_UP_PIXEL) > 1e-6) throw new Error(`zoom ${zoom} at device scale ${ratio} is not ${CLOSE_UP_PIXEL} pixels per map pixel`);
    const box = await close.locator('[data-plate="manager"]').boundingBox();
    if (box === null) throw new Error('the manager\'s name plate is not on screen');
    // The name plate 350 pixels down the 500, under the desk, as in the earlier picture.
    const picture = await areaShot(close, box.x + box.width / 2 - 400 / scale, box.y + box.height / 2 - 350 / scale, 800, 500, scale);
    await savePng(ctx, 'feature-manager.png', picture);
  } finally {
    await context.close();
  }
}

export async function officeViews(ctx, page) {
  await freshOffice(page, ctx.base);
  if (ctx.want('office.png')) await savePng(ctx, 'office.png', await page.screenshot());
  if (ctx.want('rooms-menu.png')) {
    await page.getByTestId('rooms-menu-button').click();
    await page.getByTestId('rooms-menu').waitFor();
    await pageSettled(page, 10);
    await savePng(ctx, 'rooms-menu.png', await page.screenshot());
    await page.keyboard.press('Escape');
  }
  if (ctx.want('feature-servers.png')) await wholeOfficeCard(ctx);
  if (ctx.want('feature-manager.png')) await managerCloseUp(ctx, page);
}
