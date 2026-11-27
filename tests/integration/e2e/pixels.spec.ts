import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { openOffice, settledStats, startDemoOffice, type DemoHandle, type RoomsMode } from './demo-fixture.js';

/**
 * The office as pixels: the classic four at its opening view and at zoom 0.48 and 1.33 (fractional zooms,
 * where GPU seams between chunks would show), and 5 and 24 rooms, at the fixed clock (`--still`, reduced motion) and
 * after the paint queue has settled. Each picture is compared with its baseline: at most 0.1 % of the pixels may differ
 * by more than 2 in any channel.
 *
 * Baselines live in `pixels/`, one set per platform (`<shot>.<platform>.png`: fonts and GPU differ).
 * `LUADY_UPDATE_PIXELS=1` writes this platform's set. A platform with no baseline at all skips every picture and says
 * so; on a platform that has a set, a missing picture fails.
 */

const BASELINES = join(dirname(fileURLToPath(import.meta.url)), 'pixels');
const UPDATE = process.env.LUADY_UPDATE_PIXELS === '1';
const MAX_DIFF_RATIO = 0.001;
/** Whether this platform has a set of baselines at all (any `*.<platform>.png` in pixels/). */
const PLATFORM_HAS_BASELINES = existsSync(BASELINES)
  && readdirSync(BASELINES).some((name) => name.endsWith(`.${process.platform}.png`));
const NO_BASELINES = `no ${process.platform} pixel baselines in e2e/pixels/, so the pictures are skipped here; `
  + `run the suite with LUADY_UPDATE_PIXELS=1 on this platform to create them`;
const CHANNEL_TOLERANCE = 2;

/** The classic building is 1312 map px wide (office layout); birch and cedar sit 368 map px apart in the west column. */
const CLASSIC_WIDTH_PX = 1312;
const BIRCH_TO_CEDAR_PX = 368;
/**
 * The page's live chrome, hidden in the pictures: the top bar (counts, the usage meter), the notice toasts (they come
 * and go with the seed's timers) and the fixture badges (their numbers move with the clock). What is compared is the
 * office itself: the scene, its room plaques and name plates.
 */
const LIVE_CHROME_HIDDEN = '.agency-top, .notice-toasts, [data-testid="fixture-badge"] { visibility: hidden !important; }';
/** How close the measured zoom must come to the one asked for. */
const ZOOM_TOLERANCE = 0.004;
const ZOOM_TRIES = 6;
/**
 * A wide screen opens on the whole building fitted to its width (camera-math wholeOfficeFit), so the screen's width
 * sets the zoom. The fitted area is a little wider than the building, so the width for a zoom is found by measuring:
 * the first guess is zoom × 1312, then the width is corrected from the zoom each width gave (zoomedViewport).
 */
const zoomViewport = (zoom: number, height: number) => ({ width: Math.round(zoom * CLASSIC_WIDTH_PX), height });

interface Shot {
  readonly name: string;
  readonly rooms: RoomsMode;
  readonly viewport: { readonly width: number; readonly height: number };
  /** The zoom the picture must be at (measured), when it matters. */
  readonly zoom?: number;
}

const SHOTS: readonly Shot[] = [
  { name: 'classic-opening', rooms: 'classic', viewport: { width: 1440, height: 900 } },
  { name: 'classic-zoom-0.48', rooms: 'classic', viewport: zoomViewport(0.48, 440), zoom: 0.48 },
  { name: 'classic-zoom-1.33', rooms: 'classic', viewport: zoomViewport(1.33, 1000), zoom: 1.33 },
  { name: 'rooms-5', rooms: 5, viewport: { width: 1440, height: 900 } },
  { name: 'rooms-24', rooms: 24, viewport: { width: 1440, height: 900 } },
];

/**
 * The zoom on screen. Birch and cedar are the same room one above the other, 368 map px apart, so a fixture both have
 * (its badge: `<kind>-birch` and `<kind>-cedar`, such as their links shelf) is 368 × zoom apart on screen. Room plaques
 * cannot be used: the office hides them at some zooms.
 */
async function measuredZoom(page: Page): Promise<number> {
  const badge = (id: string) => page.locator(`[data-testid="fixture-badge"][data-fixture="${id}"]`).filter({ visible: true }).first();
  const ids = await page.locator('[data-testid="fixture-badge"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-fixture') ?? ''));
  const kinds = ids.filter((id) => id.endsWith('-birch')).map((id) => id.slice(0, -'-birch'.length)).filter((kind) => ids.includes(`${kind}-cedar`));
  const apart = async (top: Locator, bottom: Locator): Promise<number | null> => {
    const [a, b] = [await top.boundingBox({ timeout: 5_000 }).catch(() => null), await bottom.boundingBox({ timeout: 5_000 }).catch(() => null)];
    return a === null || b === null ? null : (b.y + b.height / 2 - (a.y + a.height / 2)) / BIRCH_TO_CEDAR_PX;
  };
  for (const kind of kinds) {
    const zoom = await apart(badge(`${kind}-birch`), badge(`${kind}-cedar`));
    if (zoom !== null) return zoom;
  }
  // Far mode draws no fixtures: each room has a badge at the same place in its room instead.
  const room = (id: string) => page.locator(`[data-testid="room-badge"][data-room="${id}"]`).filter({ visible: true }).first();
  if (ids.length === 0 && await room('birch').count() > 0) {
    const zoom = await apart(room('birch'), room('cedar'));
    if (zoom !== null) return zoom;
  }
  throw new Error(`no fixture badge shown in both birch and cedar (badges: ${ids.join(', ')})`);
}

/** Reloads at a width and measures the zoom the opening view has there, once the paint queue has settled. */
async function zoomAt(page: Page, width: number, height: number): Promise<number> {
  await page.setViewportSize({ width, height });
  await page.reload();
  await expect(page.getByTestId('agency-page')).toBeVisible({ timeout: 60_000 });
  await settledStats(page);
  return measuredZoom(page);
}

/** Finds the width whose opening view has this zoom (secant steps from the first guess); leaves the page there. */
async function zoomedViewport(page: Page, zoom: number, height: number): Promise<number> {
  let width = zoomViewport(zoom, height).width;
  let seen = await zoomAt(page, width, height);
  let previous: { width: number; zoom: number } | null = null;
  for (let tries = 0; Math.abs(seen - zoom) > ZOOM_TOLERANCE; tries += 1) {
    if (tries >= ZOOM_TRIES) throw new Error(`no width gives zoom ${zoom} (last: ${width} px gave ${seen.toFixed(4)})`);
    const slope: number = previous === null || previous.zoom === seen ? seen / width : (seen - previous.zoom) / (width - previous.width);
    previous = { width, zoom: seen };
    width = Math.round(width + (zoom - seen) / slope);
    seen = await zoomAt(page, width, height);
  }
  return seen;
}

/** Decodes both PNGs in a blank page and counts the pixels that differ by more than the tolerance in any channel. */
async function differingPixels(browser: Browser, actual: Buffer, expected: Buffer): Promise<{ differing: number; total: number; sameSize: boolean }> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ a, b, tolerance }) => {
      const doc = (globalThis as unknown as { document: { createElement(tag: 'canvas'): {
        width: number; height: number; getContext(kind: '2d'): { drawImage(image: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };
      } } }).document;
      const load = async (base64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
        const image = await (globalThis as unknown as { createImageBitmap(blob: Blob): Promise<{ width: number; height: number }> }).createImageBitmap(blob);
        const canvas = doc.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
      };
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return { differing: x.width * x.height, total: x.width * x.height, sameSize: false };
      let differing = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        for (let c = 0; c < 4; c += 1) {
          if (Math.abs((x.data[i + c] ?? 0) - (y.data[i + c] ?? 0)) > tolerance) {
            differing += 1;
            break;
          }
        }
      }
      return { differing, total: x.width * x.height, sameSize: true };
    }, { a: actual.toString('base64'), b: expected.toString('base64'), tolerance: CHANNEL_TOLERANCE });
  } finally {
    await page.close();
  }
}

const demos = new Map<RoomsMode, DemoHandle>();


test.afterAll(async () => {
  for (const demo of demos.values()) await demo.stop();
  demos.clear();
});

for (const shot of SHOTS) {
  test(`pixels: ${shot.name}`, async ({ browser }) => {
    test.skip(!UPDATE && !PLATFORM_HAS_BASELINES, NO_BASELINES);
    const demo = demos.get(shot.rooms) ?? await startDemoOffice(shot.rooms);
    demos.set(shot.rooms, demo);
    await demo.ready;
    // bypassCSP: the hub's CSP refuses inline <style>, which is how the screenshot hides the live chrome (test only).
    const context = await browser.newContext({ viewport: shot.viewport, reducedMotion: 'reduce', ignoreHTTPSErrors: true, bypassCSP: true });
    try {
      const page = await context.newPage();
      await openOffice(page, demo);
      await settledStats(page);
      if (shot.zoom !== undefined) expect(await zoomedViewport(page, shot.zoom, shot.viewport.height), 'the zoom on screen').toBeCloseTo(shot.zoom, 2);
      const picture = await page.screenshot({ animations: 'disabled', caret: 'hide', style: LIVE_CHROME_HIDDEN });
      const file = join(BASELINES, `${shot.name}.${process.platform}.png`);
      if (UPDATE) {
        mkdirSync(BASELINES, { recursive: true });
        writeFileSync(file, picture);
        test.info().annotations.push({ type: 'baseline', description: `wrote ${file}` });
        return;
      }
      expect(existsSync(file), `no ${process.platform} baseline for ${shot.name}: run with LUADY_UPDATE_PIXELS=1 on this platform`).toBe(true);
      const { differing, total, sameSize } = await differingPixels(browser, picture, readFileSync(file));
      if (differing / total > MAX_DIFF_RATIO) await test.info().attach(`${shot.name}-actual`, { body: picture, contentType: 'image/png' });
      expect(sameSize, 'the picture has the baseline\'s size').toBe(true);
      expect(differing / total, `${differing} of ${total} pixels differ by more than ${CHANNEL_TOLERANCE}`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    } finally {
      await context.close();
    }
  });
}
