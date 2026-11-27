import { test, expect, type Page } from '@playwright/test';
import { collectErrors, openOffice, roomsOnPage, settledStats, startDemoOffice, type DemoHandle, type StageStats } from './demo-fixture.js';

/**
 * The office at scale: the demo at 0, 1, 4, 5, 24, 100 and 300 rooms (`--still`, the fixed
 * clock), on a phone and a laptop screen. Every memory and object number is read once the paint queue has settled
 * (`pending = 0`). Then a pan and zoom sweep, whose long tasks after a 2 s warm-up must stay short, and a
 * flight to the last room.
 */

const ROOM_COUNTS = [0, 1, 4, 5, 24, 100, 300] as const;
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1440, height: 900 }] as const;

/** Chunk textures: 33 MiB + 46 B per viewport CSS px² (48 at 390×844, 92 at 1440×900). */
const chunkBudget = (width: number, height: number): number => 33 + (46 * width * height) / 1e6;
const OTHER_MIB = 8;
/** The classic four's three layers, all live: at most 17 MiB. */
const CLASSIC_MIB = 17;
/** 80 live rooms × (90 + 6 × 12) + 200, at any screen size. */
const OBJECTS_ANY = 13_160;
/** With the demo seed (at most 3 sessions a room): 10,000; at 390×844 3,000. */
const objectsWithSeed = (width: number): number => (width <= 390 ? 3_000 : 10_000);
const LARGEST_SIDE = 512;
const WARM_UP_MS = 2_000;
const SWEEP_MS = 6_000;
const LONG_TASK_P99_MS = 100;
/**
 * The frame-time limit is a hard assertion only with LUADY_SCALE_STRICT=1: a machine without a graphics card draws the
 * office in software and cannot meet it. Elsewhere the measured value is printed and kept as an annotation. The memory,
 * object-count and texture budgets are hard assertions everywhere.
 */
const FRAME_TIME_STRICT = process.env.LUADY_SCALE_STRICT === '1';

/**
 * The GPU when the machine has one (headless Chromium otherwise draws WebGL in software, SwiftShader, whose frames are
 * not representative). Without a GPU Chromium falls back to SwiftShader; the renderer is recorded either way.
 */
test.use({
  launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])] },
});

/** The WebGL renderer the page got (recorded with the long tasks: software or a GPU). */
async function rendererOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { createElement(tag: 'canvas'): { getContext(kind: 'webgl2'): {
      getExtension(name: string): { UNMASKED_RENDERER_WEBGL: number } | null; getParameter(id: number): unknown;
    } | null } } }).document;
    const gl = doc.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info') ?? null;
    return info === null || gl === null ? 'unknown' : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  });
}

function expectWithinBudget(stats: StageStats, rooms: number, viewport: { width: number; height: number }, when: string): void {
  const at = `${rooms} rooms, ${viewport.width}×${viewport.height}, ${when}`;
  expect(stats.pending, at).toBe(0);
  expect(stats.textureMiB, `${at}: chunk MiB`).toBeLessThanOrEqual(chunkBudget(viewport.width, viewport.height));
  if (rooms <= 4) expect(stats.textureMiB, `${at}: the classic map`).toBeLessThanOrEqual(CLASSIC_MIB);
  expect(stats.otherMiB, `${at}: other MiB`).toBeLessThanOrEqual(OTHER_MIB);
  expect(stats.displayObjects, `${at}: display objects`).toBeLessThanOrEqual(OBJECTS_ANY);
  expect(stats.displayObjects, `${at}: display objects with the seed`).toBeLessThanOrEqual(objectsWithSeed(viewport.width));
  expect(stats.largestSide, `${at}: largest chunk side`).toBeLessThanOrEqual(LARGEST_SIDE);
  expect(stats.liveRooms, `${at}: live rooms`).toBeLessThanOrEqual(stats.far ? Number.POSITIVE_INFINITY : 80);
}

/** Records every long task from the first script on (the sweep reads the ones after its warm-up). */
async function watchLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tasks: Array<{ start: number; duration: number }> = [];
    (globalThis as { __longTasks?: typeof tasks }).__longTasks = tasks;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true } as never);
    } catch {
      // A browser without long-task timing reports none.
    }
  });
}

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

/** Drags and wheels across the stage for the warm-up and the sweep; the long tasks of the sweep part. */
async function panAndZoom(page: Page): Promise<number[]> {
  const box = await page.getByTestId('agency-stage').boundingBox();
  if (box === null) throw new Error('the stage has no box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const started = await page.evaluate(() => performance.now());
  const until = Date.now() + WARM_UP_MS + SWEEP_MS;
  for (let i = 0; Date.now() < until; i += 1) {
    const dx = (i % 2 === 0 ? 1 : -1) * box.width * 0.3;
    const dy = (i % 3 === 0 ? 1 : -1) * box.height * 0.2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel(0, i % 4 < 2 ? -240 : 240);
    await page.waitForTimeout(120);
  }
  return page.evaluate((from) => ((globalThis as { __longTasks?: Array<{ start: number; duration: number }> }).__longTasks ?? [])
    .filter((task) => task.start >= from).map((task) => task.duration), started + WARM_UP_MS);
}

/** Through the Rooms menu, as the owner does: find the last room by name, Enter. */
async function flyToLastRoom(page: Page): Promise<string | null> {
  const rooms = await roomsOnPage(page);
  const last = rooms.toSorted((a, b) => b.position - a.position)[0];
  if (last === undefined) return null;
  await page.getByTestId('rooms-menu-button').click();
  const search = page.getByRole('combobox', { name: 'Find a room by name, server or kind' });
  await search.fill(last.name);
  await expect(page.getByTestId('rooms-menu').locator(`[data-room="${last.id}"]`)).toBeVisible();
  await search.press('Enter');
  return last.id;
}

/**
 * The room's name is on screen after the flight: its plaque's name, or its far badge's. (A plaque is a pin as wide as
 * its wall run, so only its name label says where the room is drawn.)
 */
async function expectInView(page: Page, roomId: string): Promise<void> {
  const name = page.locator([
    `[data-testid="room-plaque"][data-room="${roomId}"] .map-plaque__name`,
    `[data-testid="room-badge"][data-room="${roomId}"] .map-far__name`,
  ].join(', ')).first();
  await expect(name).toBeInViewport({ timeout: 15_000 });
}

for (const rooms of ROOM_COUNTS) {
  test.describe(`the office with ${rooms} rooms`, () => {
    let demo: DemoHandle | null = null;

    test.beforeAll(async () => {
      demo = await startDemoOffice(rooms);
      await demo.ready;
    });
    test.afterAll(async () => {
      await demo?.stop();
    });

    for (const viewport of VIEWPORTS) {
      test(`${viewport.width}×${viewport.height}: within budget, a smooth sweep, and a flight to the last room`, async ({ browser }) => {
        if (demo === null) throw new Error('the demo did not start');
        const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
        try {
          const page = await context.newPage();
          await watchLongTasks(page);
          const errors = collectErrors(page);
          await openOffice(page, demo);
          expectWithinBudget(await settledStats(page), rooms, viewport, 'the opening view');

          const longTasks = await panAndZoom(page);
          const measured = `${await rendererOf(page)}: p99 ${percentile(longTasks, 99)} ms of ${longTasks.length} (${longTasks.join(', ')})`;
          test.info().annotations.push({ type: 'long tasks', description: measured });
          if (FRAME_TIME_STRICT) {
            expect(percentile(longTasks, 99), `long tasks after the warm-up: ${longTasks.join(', ')}`).toBeLessThanOrEqual(LONG_TASK_P99_MS);
          } else {
            console.log(`scale ${rooms} rooms ${viewport.width}×${viewport.height}: long tasks ${measured} (limit ${LONG_TASK_P99_MS} ms, checked with LUADY_SCALE_STRICT=1)`);
          }
          expectWithinBudget(await settledStats(page), rooms, viewport, 'after the sweep');

          const last = await flyToLastRoom(page);
          if (last !== null) {
            await expectInView(page, last);
            expectWithinBudget(await settledStats(page), rooms, viewport, `at ${last}`);
          }
          expect(errors, 'console and WebGL errors').toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  });
}
