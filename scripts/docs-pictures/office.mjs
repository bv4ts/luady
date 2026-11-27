// The office pictures, on the demo's classic fleet: the rooms Cedar, Birch and Ash are added in the room editor as an
// owner adds them, then the office, its Rooms menu, a room's panel, a phone and the close-ups are taken.
import { newPage, officeSettled, pageApi, pageSettled, areaShot } from './browser.mjs';
import { DEMO_PIN } from './demo.mjs';
import { savePng } from './pictures.mjs';

export const DESKTOP_VIEW = Object.freeze({ width: 1440, height: 900 });
/** A phone: 390 x 844 CSS pixels at twice the density. */
const PHONE_VIEW = Object.freeze({ width: 390, height: 844, scale: 2, phone: true });
/** The rooms of the pictures, in the order they are added: a server each, in the editor's own colour and creature. */
export const ROOMS = Object.freeze([
  { spot: 1, server: 'cedar', name: 'Cedar' },
  { spot: 2, server: 'birch', name: 'Birch' },
  { spot: 3, server: 'ash', name: 'Ash' },
]);

/** Signs a page in through the demo's one-time link and waits for the office. */
export async function signIn(ctx) {
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...DESKTOP_VIEW });
  await page.goto(ctx.preview.loginUrl());
  await page.getByTestId('agency-page').waitFor({ timeout: 60_000 });
  await officeSettled(page);
  return { context, page };
}

/**
 * Removes the demo's four classic rooms (the pictures add their own), and keeps each room's links so they can be put
 * back on the shelf of the room that takes its place.
 */
export async function clearRooms(page) {
  const links = (await pageApi(page, 'GET', '/api/links')).items;
  const rooms = (await pageApi(page, 'GET', '/api/rooms')).items;
  for (const room of rooms) {
    await pageApi(page, 'POST', `/api/rooms/${room.id}/delete`, { links: 'delete', jira: 'disconnect', pin: DEMO_PIN });
  }
  return links.toSorted((a, b) => a.position - b.position);
}

/**
 * No quiet hours. The office's light follows the demo's fixed clock (6:07 PM), but the quiet hours that dim HQ follow
 * the computer's real clock (00:00 to 08:00 by default), so a picture taken at night would show HQ dimmed. Equal start
 * and end mean "never quiet", and every picture shows HQ as it is at 6:07 PM.
 */
export async function noQuietHours(page) {
  await pageApi(page, 'PUT', '/api/settings', { quiet_hours: { start: '00:00', end: '00:00' } });
}

/** Puts a room's links back on its shelf, as the owner adds links. */
export async function restoreLinks(page, links, roomId) {
  for (const link of links.filter((l) => l.server === roomId)) {
    await pageApi(page, 'POST', '/api/links', { server: roomId, label: link.label, url: link.url });
  }
}

/** Opens the room editor from a free spot's "+ Add room" and fills in a server room; colour and creature stay as offered. */
export async function fillRoomEditor(page, room) {
  await page.getByRole('button', { name: `Add a room in spot ${room.spot}` }).click();
  const editor = page.getByTestId('room-editor');
  await editor.getByRole('radio', { name: /A server/ }).check();
  await editor.getByLabel('Server', { exact: true }).selectOption(room.server);
  await editor.getByLabel('Name', { exact: true }).fill(room.name);
  await editor.getByText(/live sessions? would sit here/).waitFor();
  // Typing leaves a focus ring on the name field; a person who clicks "Add the room" next would not show one.
  await editor.evaluate(() => document.activeElement?.blur());
  return editor;
}

/** "Add the room": the camera flies to it and its panel opens. Its links go back on its shelf meanwhile. */
export async function addRoom(page, editor, room, links) {
  await editor.getByRole('button', { name: 'Add the room' }).click();
  await page.getByText(`${room.name} is on the map.`).waitFor();
  await restoreLinks(page, links, room.server);
  await page.getByRole('button', { name: 'Close panel' }).waitFor();
}

/** Back to the whole office, no panel open. */
export async function wholeOffice(page) {
  const close = page.getByRole('button', { name: 'Close panel' });
  if (await close.isVisible()) await close.click();
  await page.getByRole('button', { name: 'Whole office' }).click();
}

/** The editor with its colour and creature open, as at the top of the Rooms pop-up. */
async function openLook(editor) {
  await editor.locator('summary', { hasText: 'Colour, creature and more' }).click();
  await editor.getByRole('radiogroup', { name: 'Creatures' }).waitFor();
  // Opening it may scroll the pop-up: back to its top, where "What is this room for?" is.
  await editor.evaluate((node) => {
    for (let el = node; el !== null; el = el.parentElement) if (el.scrollTop > 0) el.scrollTop = 0;
  });
}

/** The room editor for Cedar on an empty office (room-editor.png); the same editor at 3/4 size for the card. */
async function editorShots(ctx, page) {
  const editor = await fillRoomEditor(page, ROOMS[0]);
  await openLook(editor);
  await pageSettled(page);
  if (ctx.want('room-editor.png')) await savePng(ctx, 'room-editor.png', await page.screenshot());
  if (ctx.want('feature-rooms.png')) await featureRooms(ctx);
  return editor;
}

/**
 * feature-rooms.png: the editor's fields from "What is this room for?" to the creatures, 800 x 500. The page is drawn
 * at 3/4 of its size by the browser itself (no picture is scaled afterwards), so the whole editor fits.
 */
async function featureRooms(ctx) {
  const scale = 0.75;
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...DESKTOP_VIEW, scale, storageState: ctx.storageState });
  try {
    await page.goto(`${ctx.base}/`);
    await page.getByTestId('agency-page').waitFor({ timeout: 60_000 });
    await officeSettled(page);
    const editor = await fillRoomEditor(page, ROOMS[0]);
    await openLook(editor);
    await pageSettled(page);
    const box = await editor.boundingBox();
    // Centred on the editor, 12 picture pixels above "What is this room for?", as in the earlier picture.
    const picture = await areaShot(page, box.x + box.width / 2 - 400 / scale, box.y - 12 / scale, 800, 500, scale);
    await savePng(ctx, 'feature-rooms.png', picture);
  } finally {
    await context.close();
  }
}

/** The office on a phone (phone.png). */
async function phoneShot(ctx) {
  if (!ctx.want('phone.png')) return;
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...PHONE_VIEW, storageState: ctx.storageState });
  try {
    await page.goto(`${ctx.base}/`);
    await page.getByTestId('agency-page').waitFor({ timeout: 60_000 });
    await officeSettled(page);
    await pageSettled(page);
    await savePng(ctx, 'phone.png', await page.screenshot());
  } finally {
    await context.close();
  }
}

/**
 * From an empty office to Cedar and Birch: the phone and the editor pictures on the empty office, then Cedar's panel
 * right after it was added (room-panel.png), then Birch.
 */
export async function firstRooms(ctx, page, links) {
  await page.reload();
  await page.getByTestId('agency-page').waitFor({ timeout: 60_000 });
  await officeSettled(page);
  await phoneShot(ctx);
  const editor = await editorShots(ctx, page);
  await addRoom(page, editor, ROOMS[0], links);
  await page.waitForTimeout(1_500);
  await officeSettled(page);
  if (ctx.want('room-panel.png')) await savePng(ctx, 'room-panel.png', await page.screenshot());
  await wholeOffice(page);
  await addRoom(page, await fillRoomEditor(page, ROOMS[1]), ROOMS[1], links);
  await wholeOffice(page);
}
