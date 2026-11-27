import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { freePort } from '../harness/hub.js';
import { REPO_ROOT } from '../harness/paths.js';

/** The preview hub as a worker fixture for the preview journeys (preview/main.ts, port chosen free). */

export interface PreviewHandle {
  readonly url: string;
  readonly port: number;
  readonly ready: Promise<void>;
  /** This run's one-time sign-in link: each use makes the next one. */
  loginUrl(): string;
  stop(): Promise<void>;
}
interface PreviewModule { startPreview(opts: { port?: number; env?: NodeJS.ProcessEnv; logLevel?: string }): Promise<PreviewHandle> }

/** Loaded at run time: the preview is TypeScript run by Node's own type stripping, outside this folder's typecheck. */
async function loadPreview(): Promise<PreviewModule> {
  return (await import(pathToFileURL(join(REPO_ROOT, 'preview', 'main.ts')).href)) as PreviewModule;
}

export const test = base.extend<{ office: Page }, { preview: PreviewHandle }>({
  preview: [
    async ({}, use) => {
      const { startPreview } = await loadPreview();
      const preview = await startPreview({ port: await freePort(), env: {}, logLevel: 'silent' });
      try {
        await preview.ready;
        await use(preview);
      } finally {
        await preview.stop();
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  office: async ({ page, preview }, use) => {
    await page.goto(preview.loginUrl());
    await expect(page.getByTestId('agency-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-plate="manager"]')).toBeVisible({ timeout: 30_000 });
    await use(page);
  },
});

export async function drive(preview: PreviewHandle, scenario: string, args: readonly string[]): Promise<string> {
  const res = await fetch(`${preview.url}/__preview/run`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `https://localhost:${preview.port}` }, body: JSON.stringify({ scenario, args }),
  });
  const body = (await res.json()) as { ok: boolean; result?: string; error?: string };
  if (!body.ok) throw new Error(`${scenario}: ${body.error ?? res.status}`);
  return body.result ?? '';
}

/** A card made through the page's own session, as "+ Add" would; with the page key the page keeps. */
export async function addCard(page: Page, body: Record<string, unknown>): Promise<number> {
  return page.evaluate(async (card) => {
    const key = localStorage.getItem('hub.pageKey');
    const keyed: Record<string, string> = key === null ? {} : { 'x-hub-key': key };
    const me = (await (await fetch('/api/me', { headers: keyed })).json()) as { csrf: string };
    const res = await fetch('/api/board', {
      method: 'POST', headers: { ...keyed, 'content-type': 'application/json', 'x-hub-csrf': me.csrf }, body: JSON.stringify(card),
    });
    return ((await res.json()) as { id: number }).id;
  }, body);
}

export async function cardState(page: Page, id: number): Promise<string> {
  return page.evaluate(async (cardId) => {
    const key = localStorage.getItem('hub.pageKey');
    const res = await fetch(`/api/board/${cardId}`, { headers: key === null ? {} : { 'x-hub-key': key } });
    return ((await res.json()) as { item: { state: string } }).item.state;
  }, id);
}

export { expect };
export type { Page };
