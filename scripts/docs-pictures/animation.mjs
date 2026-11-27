// The frames of office-demo.webp: on the office with Cedar and Birch, a room is added for the server ash, then the
// camera visits the rooms and goes back to the whole office. Frames are taken at a fixed step while the actions run.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newPage, officeSettled, pageSettled } from './browser.mjs';
import { addRoom, fillRoomEditor, ROOMS, wholeOffice } from './office.mjs';

/** A 1280 x 800 laptop screen, drawn by the browser at 800 x 500 (5/8 scale), so no frame is scaled afterwards. */
const ANIMATION_VIEW = Object.freeze({ width: 1280, height: 800, scale: 0.625 });
/** One frame every this many milliseconds (a frame that takes longer to take simply stays longer). */
const FRAME_STEP_MS = 120;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Takes frames until stopped; each frame's duration is the time until the next one was taken. */
function startFrames(page, folder) {
  const frames = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const at = Date.now();
      const file = `frame-${String(frames.length).padStart(3, '0')}.png`;
      await writeFile(join(folder, file), await page.screenshot());
      frames.push({ file, at });
      await wait(Math.max(0, FRAME_STEP_MS - (Date.now() - at)));
    }
  })();
  return async () => {
    running = false;
    await loop;
    return frames.map((frame, i) => ({ file: frame.file, ms: (frames[i + 1]?.at ?? frame.at + FRAME_STEP_MS) - frame.at }));
  };
}

/** Clicks a room's chip at the top (its label starts with the room's name). */
async function visit(page, name, stayMs) {
  await page.getByRole('group', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name},`) }).click();
  await wait(stayMs);
}

/** The story, about 11 seconds. */
async function story(page, links) {
  const ash = ROOMS[2];
  await wait(1_000);
  const editor = await fillRoomEditor(page, ash);
  await wait(900);
  await addRoom(page, editor, ash, links);
  await wait(1_800);
  await wholeOffice(page);
  await wait(900);
  await visit(page, 'Cedar', 1_500);
  await visit(page, 'Birch', 1_500);
  await wholeOffice(page);
  await wait(1_300);
}

/** Opens the room editor once and cancels it, so the recording never shows it still loading ("Opening..."). */
async function warmEditor(page) {
  await page.getByRole('button', { name: `Add a room in spot ${ROOMS[2].spot}` }).click();
  const editor = page.getByTestId('room-editor');
  await editor.waitFor();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await editor.waitFor({ state: 'detached' });
}

/** Takes the animation's frames into `folder` (emptied first) and writes frames.json there. */
export async function animationFrames(ctx, links, folder) {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const { context, page } = await newPage(ctx.browser, { clock: ctx.clockLabel, ...ANIMATION_VIEW, storageState: ctx.storageState });
  try {
    await page.goto(`${ctx.base}/`);
    await page.getByTestId('agency-page').waitFor({ timeout: 60_000 });
    await officeSettled(page);
    await warmEditor(page);
    await officeSettled(page);
    await pageSettled(page, 30);
    const stop = startFrames(page, folder);
    try {
      await story(page, links);
    } finally {
      const frames = await stop();
      await writeFile(join(folder, 'frames.json'), JSON.stringify(frames, null, 1));
      console.log(`  ${frames.length} frames, ${(frames.reduce((sum, f) => sum + f.ms, 0) / 1000).toFixed(1)} s`);
    }
  } finally {
    await context.close();
  }
}
