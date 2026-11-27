#!/usr/bin/env node
// Retakes the pictures in docs/assets from the running product: the demo (the real hub and website with a pretend
// fleet), driven by Playwright. See README.md in this folder.
//
//   node --experimental-strip-types scripts/docs-pictures/capture.mjs [--only a.png,b.png] [--out docs/assets]
//        [--frames <folder>] [--python python3] [--clock <ISO time>] [--any-size]
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { animationFrames } from './animation.mjs';
import { pinConfirmShot } from './confirmation.mjs';
import { BROWSER_ZONE, clockLabel, loadTestModules, noticesSettled } from './browser.mjs';
import { startNewInstallDemo, startOfficeDemo } from './demo.mjs';
import { firstRunPictures } from './first-run.mjs';
import { addRoom, clearRooms, fillRoomEditor, firstRooms, noQuietHours, ROOMS, signIn, wholeOffice } from './office.mjs';
import { officeViews } from './office-views.mjs';
import { PICTURES, wanted } from './pictures.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/**
 * The office clock: 14:07:30 UTC is 18:07:30 in the demo owner's zone (Etc/GMT-4, preview/config.ts), the middle of
 * dusk (5:30 to 6:45 PM, packages/office/src/ambience.ts). The light is then exactly the map's own art, nothing tinted.
 */
const DEFAULT_CLOCK = '2026-11-21T14:07:30Z';
const FIRST_RUN = ['setup-claim.png', 'setup-pin.png', 'setup-rooms.png', 'setup-open.png', 'settings.png',
  'add-server-details.png', 'add-server-key-line.png'];
const ANIMATION = 'office-demo.webp';

function parseArgs(argv) {
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at === -1 ? fallback : argv[at + 1];
  };
  // --only takes picture names, or a group: "office" (every office picture and the animation) or "first-run".
  const groups = { 'first-run': FIRST_RUN, office: Object.keys(PICTURES).filter((name) => !FIRST_RUN.includes(name)) };
  const only = value('--only', null)?.split(',').map((name) => name.trim()).filter(Boolean)
    .flatMap((name) => groups[name] ?? [name]) ?? null;
  for (const name of only ?? []) if (!(name in PICTURES)) throw new Error(`--only: ${name} is not a docs picture or group`);
  const clock = new Date(value('--clock', DEFAULT_CLOCK));
  if (Number.isNaN(clock.getTime())) throw new Error('--clock takes an ISO time, such as 2026-11-21T14:07:30Z');
  return {
    only,
    clock,
    // What the top bar's clock shows in every picture: the office clock in the demo's fixed zone.
    clockLabel: clockLabel(clock, BROWSER_ZONE),
    outDir: resolve(value('--out', join(REPO_ROOT, 'docs', 'assets'))),
    framesDir: resolve(value('--frames', join(tmpdir(), 'luady-docs-pictures-frames'))),
    python: value('--python', process.platform === 'win32' ? 'python' : 'python3'),
    anySize: argv.includes('--any-size'),
  };
}

/** The setup wizard and Settings pictures, on a demo returned to a new install's first run. */
async function newInstallRun(base) {
  const { preview, remove } = await startNewInstallDemo(REPO_ROOT, base.clock);
  try {
    await firstRunPictures({ ...base, preview, base: `https://localhost:${preview.port}` });
  } finally {
    await remove();
  }
}

/** The office pictures and the animation's frames, on the classic demo. */
async function officeRun(base) {
  const preview = await startOfficeDemo(REPO_ROOT, base.clock);
  const signed = await signIn({ ...base, preview });
  try {
    const ctx = { ...base, preview, base: preview.url, storageState: await signed.context.storageState() };
    await noQuietHours(signed.page);
    const links = await clearRooms(signed.page);
    await noticesSettled(signed.page);
    await firstRooms(ctx, signed.page, links);
    if (ctx.want(ANIMATION)) {
      await animationFrames(ctx, links, ctx.framesDir);
    } else {
      await addRoom(signed.page, await fillRoomEditor(signed.page, ROOMS[2]), ROOMS[2], links);
      await wholeOffice(signed.page);
    }
    await officeViews(ctx, signed.page);
    await pinConfirmShot(ctx);
  } catch (err) {
    await base.debugShot(signed.page, 'office');
    throw err;
  } finally {
    await signed.context.close();
    await preview.stop();
  }
}

/** On a failure: what the page showed, next to the animation frames, for the one who fixes the script. */
function debugShotter(framesDir) {
  return async (page, label) => {
    const path = join(dirname(framesDir), `luady-docs-pictures-failed-${label}.png`);
    await page.screenshot({ path }).then(() => console.error(`  the page at the failure: ${path}`), () => undefined);
  };
}

/** office-demo.webp from the frames, with Python and Pillow. */
function assembleAnimation({ python, framesDir, outDir }) {
  const script = join(REPO_ROOT, 'scripts', 'docs-pictures', 'assemble_webp.py');
  const result = spawnSync(python, [script, framesDir, join(outDir, ANIMATION)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${python} ${script} failed; it needs Python 3 with Pillow (pip install Pillow)`);
}

/**
 * Chromium on the graphics card when there is one: with the software renderer a frame of the office takes about a
 * second, too slow for the animation. Says which renderer the pages get.
 */
async function launchBrowser(playwright) {
  const gpu = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])];
  const browser = await playwright.chromium.launch({ args: gpu });
  const page = await browser.newPage();
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no WebGL';
  });
  await page.close();
  console.log(`WebGL: ${renderer}`);
  if (/SwiftShader|no WebGL/i.test(renderer)) console.warn('  no graphics card: the animation will have few frames');
  return browser;
}

/** The browser's zone must be the demo's fixed one: a page that names the browser's zone then names only that one. */
async function checkZone() {
  const { PREVIEW_OWNER_TZ } = await import(pathToFileURL(join(REPO_ROOT, 'preview', 'config.ts')).href);
  if (PREVIEW_OWNER_TZ !== BROWSER_ZONE) throw new Error(`browser.mjs BROWSER_ZONE (${BROWSER_ZONE}) is not the demo's zone ${PREVIEW_OWNER_TZ}`);
}

async function main() {
  await checkZone();
  const options = parseArgs(process.argv.slice(2));
  const want = wanted(options.only);
  const { playwright, WebSocket } = loadTestModules(REPO_ROOT);
  const browser = await launchBrowser(playwright);
  const base = { ...options, repoRoot: REPO_ROOT, want, browser, WebSocket, debugShot: debugShotter(options.framesDir) };
  const failed = [];
  const phase = async (title, run) => {
    console.log(title);
    await run(base).catch((err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      failed.push(title);
    });
  };
  try {
    const office = Object.keys(PICTURES).some((name) => want(name) && !FIRST_RUN.includes(name));
    if (office) await phase('The office: rooms, panel, phone, close-ups, animation frames', officeRun);
    if (FIRST_RUN.some(want)) await phase('New install: the setup wizard, Settings, Add a server', newInstallRun);
  } finally {
    await browser.close();
  }
  if (want(ANIMATION) && !failed.some((title) => title.startsWith('The office'))) assembleAnimation(options);
  if (failed.length > 0) throw new Error(`not finished: ${failed.join('; ')}`);
  console.log('Done.');
}

main().then(() => process.exit(0), (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
