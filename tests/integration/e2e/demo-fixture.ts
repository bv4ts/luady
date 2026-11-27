import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { freePort } from '../harness/hub.js';
import { REPO_ROOT } from '../harness/paths.js';

/**
 * `npm run demo` in this process (preview/demo.ts): the scale, pixels and rooms specs start it with the
 * flags they need. The global setup has built the checkout, so the demo never builds here.
 */

export type RoomsMode = number | 'classic' | 'mixed';

export interface DemoHandle {
  readonly url: string;
  readonly port: number;
  readonly ready: Promise<void>;
  loginUrl(): string;
  stop(): Promise<void>;
}

interface DemoCli {
  readonly rooms: RoomsMode; readonly loop: boolean; readonly clock: Date | undefined; readonly port: number; readonly keep: undefined; readonly open: false;
}
interface DemoModule {
  startDemo(cli: DemoCli, deps: {
    env: NodeJS.ProcessEnv; repoRoot: string; build(root: string): void; open(url: string): void; onLoginLink(url: string): void;
  }): Promise<DemoHandle>;
}

/** The fixed office clock of the scale and pixel specs: midday, so daylight never moves. */
export const DEMO_CLOCK = new Date('2026-11-21T12:00:00Z');

/** Loaded at run time: the preview is TypeScript run by Node's own type stripping, outside this folder's typecheck. */
async function loadDemo(): Promise<DemoModule> {
  return (await import(pathToFileURL(join(REPO_ROOT, 'preview', 'demo.ts')).href)) as DemoModule;
}

export async function startDemoOffice(rooms: RoomsMode, opts: { loop?: boolean; clock?: Date } = {}): Promise<DemoHandle> {
  const { startDemo } = await loadDemo();
  return startDemo(
    { rooms, loop: opts.loop ?? false, clock: opts.clock ?? DEMO_CLOCK, port: await freePort(), keep: undefined, open: false },
    {
      env: {}, repoRoot: REPO_ROOT, onLoginLink: () => undefined, open: () => undefined,
      build: () => {
        throw new Error('the e2e global setup builds the checkout; the demo found it missing or stale');
      },
    },
  );
}

/** Signs this page in through the demo's one-time link and waits for the office. */
export async function openOffice(page: Page, demo: DemoHandle): Promise<void> {
  await page.goto(demo.loginUrl());
  await expect(page.getByTestId('agency-page')).toBeVisible({ timeout: 60_000 });
}

export interface StageStats {
  readonly textures: number;
  readonly textureMiB: number;
  readonly otherMiB: number;
  readonly displayObjects: number;
  readonly chunksLive: number;
  readonly liveRooms: number;
  readonly pending: number;
  readonly far: boolean;
  readonly largestSide: number;
}

/** The stage's own numbers, once its paint queue has settled (`pending = 0`). */
export async function settledStats(page: Page, timeout = 90_000): Promise<StageStats> {
  await page.waitForFunction(() => {
    const read = (globalThis as { __luadyStageStats?: () => { pending: number } }).__luadyStageStats;
    return read !== undefined && read().pending === 0;
  }, undefined, { timeout, polling: 100 });
  // One more frame: what was released in the frame that settled is gone from the counts too.
  await page.evaluate(() => new Promise<void>((done) => { const frame = (globalThis as unknown as { requestAnimationFrame(cb: () => void): number }).requestAnimationFrame; frame(() => frame(() => done())); }));
  await page.waitForFunction(() => (globalThis as { __luadyStageStats?: () => { pending: number } }).__luadyStageStats?.().pending === 0,
    undefined, { timeout, polling: 100 });
  return page.evaluate(() => (globalThis as unknown as { __luadyStageStats: () => StageStats }).__luadyStageStats());
}

/** Console errors and page errors (WebGL ones included), collected from the first script on. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.type() === 'warning' && /webgl|gl_|context lost/i.test(message.text())) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** The rooms as the signed-in page reads them. */
export async function roomsOnPage(page: Page): Promise<Array<{ id: string; name: string; position: number; colour: string }>> {
  return page.evaluate(async () => {
    const key = localStorage.getItem('hub.pageKey');
    const res = await fetch('/api/rooms', { headers: key === null ? {} : { 'x-hub-key': key } });
    return ((await res.json()) as { items: Array<{ id: string; name: string; position: number; colour: string }> }).items;
  });
}
