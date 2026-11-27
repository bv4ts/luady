import { buildOffice, fixturesFor } from '@luady/office';
import type { RoomDTO } from '@luady/shared';
import { addCard, drive, expect, test, type Page } from './preview-fixture.js';

/**
 * Journeys in the preview hub: day and night, the welcome-back card, Help, the speaker, the fleet wall,
 * wins, today, schedule and links opened from their fixtures, context fuel with Compact, "Remind me…" and Later, and
 * the reminder notices. Desktop and phone.
 */

interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
interface Badge { readonly id: string; readonly cx: number; readonly cy: number }

/** The rooms the page draws, read through its own session (GET /api/rooms, with the page key it keeps). */
async function pageRooms(page: Page): Promise<RoomDTO[]> {
  return page.evaluate(async () => {
    const key = localStorage.getItem('hub.pageKey');
    const res = await fetch('/api/rooms', { headers: key === null ? {} : { 'x-hub-key': key } });
    return ((await res.json()) as { items: RoomDTO[] }).items;
  });
}

/**
 * Fixture boxes in map pixels: the office's own `fixturesFor` over the rooms the hub reports, with a Jira board in the
 * rooms whose Jira badge is on screen. Never a copied table, so a layout change moves the boxes with it.
 */
async function fixtureBoxes(page: Page, badges: readonly Badge[]): Promise<ReadonlyMap<string, Box>> {
  const jiraRooms = badges.filter((b) => b.id.startsWith('jira-')).map((b) => b.id.slice('jira-'.length));
  const fixtures = fixturesFor(buildOffice(await pageRooms(page)), { jiraRooms });
  return new Map(fixtures.map((f) => [f.id, f.box]));
}

/**
 * Where a fixture is on screen: two visible badges with known map anchors give the camera's scale and offset (a badge
 * hangs at its fixture's top-right corner; only its height may be clamped below the top bar, never its x).
 */
async function pressFixture(page: Page, id: string): Promise<void> {
  const badges: Badge[] = await page.$$eval('[data-testid="fixture-badge"]', (nodes) => nodes.filter((n) => !n.hasAttribute('hidden')).map((n) => {
    const r = n.getBoundingClientRect();
    return { id: n.getAttribute('data-fixture') ?? '', cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }));
  const boxes = await fixtureBoxes(page, badges);
  const box = (fixture: string): Box => {
    const found = boxes.get(fixture);
    if (found === undefined) throw new Error(`no fixture ${fixture} on this map`);
    return found;
  };
  const known = badges.filter((b) => boxes.has(b.id));
  expect(known.length, `badges to place ${id}`).toBeGreaterThanOrEqual(2);
  const right = (b: { id: string }): number => box(b.id).x + box(b.id).w;
  const sorted = [...known].sort((a, b) => right(a) - right(b));
  const a = sorted[0]!;
  const b = sorted.at(-1)!;
  const scale = (b.cx - a.cx) / (right(b) - right(a));
  const ox = a.cx - scale * right(a);
  const low = [...known].sort((p, q) => q.cy - p.cy)[0]!;
  const oy = low.cy - scale * box(low.id).y;
  const f = box(id);
  await page.mouse.click(ox + scale * (f.x + f.w / 2), oy + scale * (f.y + f.h / 2));
}

/** A fresh sign-in and page load, so the page hook's next script (clock, away) runs. */
async function reload(page: Page, preview: { loginUrl(): string }): Promise<void> {
  await page.goto(preview.loginUrl());
  await expect(page.locator('[data-plate="manager"]')).toBeVisible({ timeout: 30_000 });
}

const close = (page: Page) => page.keyboard.press('Escape');
const stamp = (): string => Date.now().toString(36).slice(-5);

test.describe('desktop 1920×1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('day and night load; the welcome-back card after an away; Help and Show me; the speaker mutes', async ({ office: page, preview }) => {
    for (const light of ['night', 'dusk', 'day']) {
      await drive(preview, 'light', [light]);
      await reload(page, preview);
      await expect(page.getByTestId('agency-page')).toBeVisible();
    }
    await drive(preview, 'clock', ['off']);
    await drive(preview, 'away', ['180']);
    await reload(page, preview);
    const card = page.getByTestId('welcome-back');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Waiting for you');
    await card.getByRole('button', { name: 'Got it' }).click();
    await expect(card).toHaveCount(0);

    await page.keyboard.press('?');
    const help = page.getByTestId('help-modal');
    await expect(help).toBeVisible();
    await help.getByRole('button', { name: /Show me the wins/i }).first().click();
    await expect(help).toHaveCount(0);

    const speaker = page.getByTestId('sound-button');
    const before = await speaker.getAttribute('aria-label');
    await speaker.click();
    await expect(speaker).not.toHaveAttribute('aria-label', before ?? '');
    await speaker.click();
    await expect(speaker).toHaveAttribute('aria-label', before ?? '');
  });

  test('the fleet wall, wins, today and the schedule open from their fixtures; a reminder is added', async ({ office: page }) => {
    await pressFixture(page, 'tv-hq');
    await expect(page.getByTestId('fleet-modal')).toContainText('Orchard');
    await close(page);
    await pressFixture(page, 'wins-hq');
    await expect(page.getByTestId('wins-modal')).toContainText('Checkout total includes the delivery fee');
    await close(page);
    await pressFixture(page, 'clock-hq');
    const today = page.getByTestId('timeline-modal');
    await expect(today).toBeVisible();
    await today.getByRole('button', { name: 'Yesterday' }).click();
    await expect(today).toContainText('arrived');
    await close(page);
    await pressFixture(page, 'schedule-hq');
    const calendar = page.getByTestId('schedule-modal');
    await expect(calendar).toContainText('Check the Orchard staging build');
    await calendar.getByRole('button', { name: '+ Add a reminder' }).click();
    const form = page.getByRole('form', { name: 'A new reminder' });
    const task = `Water the office plants ${stamp()}`;
    await form.getByLabel('What should Luady do?').fill(task);
    await form.getByRole('button', { name: 'Add to the calendar' }).click();
    await expect(calendar).toContainText(task, { timeout: 10_000 });
    await close(page);
  });

  test('links: view and edit in the Orchard room', async ({ office: page }) => {
    // From the whole office: every room's badges are on screen to place the board by.
    await pressFixture(page, 'links-birch');
    const shelf = page.getByTestId('links-modal');
    await expect(shelf).toContainText('Staging');
    await expect(shelf.locator('a[href="https://staging.orchard.example"]')).toHaveAttribute('rel', /noopener/);
    await shelf.getByRole('button', { name: 'Edit' }).click();
    await expect(shelf.getByRole('button', { name: 'Move Staging up' })).toBeVisible();
    await close(page);
  });

  test('context fuel: Compact now in the agent view and the right-click menu', async ({ office: page, preview }) => {
    await drive(preview, 'meters', ['birch/app-frontend', '72']);
    await drive(preview, 'meters', ['birch/checkout-fix', '93']);
    await page.keyboard.press('1');
    await page.waitForTimeout(1200);
    await page.locator('[data-plate="agent"]').filter({ hasText: 'app-frontend' }).first().click();
    await page.getByTestId('compact-offer').getByRole('button', { name: 'Compact now' }).click();
    await expect(page.getByText(/Compacting birch · app-frontend/).first()).toBeVisible();
    await close(page);
    const plate = await page.locator('[data-plate="agent"]').filter({ hasText: 'checkout-fix' }).first().boundingBox();
    await page.mouse.click(plate!.x + plate!.width / 2, plate!.y - 30, { button: 'right' });
    await expect(page.getByTestId('actor-menu-compact')).toContainText('93%');
    await close(page);
  });

  test('Remind me… hides a card in Later; a snooze that ends and a due time that passes each give a notice', async ({ office: page, preview }) => {
    const title = `Book the meeting room ${stamp()}`;
    await addCard(page, { title, project: 'app-backend', server: 'birch' });
    await page.locator('button[data-tool="board"]').click();
    await page.locator(`article[aria-label="${title}"] .paper-card__title`).click();
    await page.getByRole('button', { name: 'Remind me…' }).click();
    await page.getByRole('menuitem', { name: 'Tomorrow, 9:00 AM' }).click();
    await page.getByRole('button', { name: 'Back to the board' }).click();
    await page.getByRole('button', { name: /^Later:/ }).click();
    const later = page.getByRole('list', { name: 'Cards for later' });
    await expect(later).toContainText(title);
    await later.locator('li').filter({ hasText: title }).getByRole('button', { name: 'Bring back now' }).click();
    await expect(page.locator(`article[aria-label="${title}"][data-lane="todo"]`)).toBeVisible();
    await close(page);

    const tag = stamp();
    await drive(preview, 'snooze', ['0.02', `Water the plants ${tag}`]);
    await drive(preview, 'due', ['0.02', `Send the contract ${tag}`]);
    await page.waitForTimeout(1500);
    await drive(preview, 'remind', []);
    await expect(page.getByText(`Back on your board: Water the plants ${tag}`).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`Due now: Send the contract ${tag}`).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('the top bar fits with the speaker; the welcome-back card; Help from the robot; Later on the board', async ({ office: page, preview }) => {
    await expect(page.getByTestId('sound-button')).toBeVisible();
    // Nothing pushes the page wider than the phone.
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await drive(preview, 'away', ['240']);
    await reload(page, preview);
    const card = page.getByTestId('welcome-back');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Got it' }).click();

    // The room button flies to HQ and opens HQ's room sheet; on a phone the map behind the sheet is in far mode,
    // with no furniture to tap, so the sheet is closed first.
    await page.getByRole('button', { name: /^Luady HQ/ }).first().click();
    await page.waitForTimeout(1500);
    await close(page);
    await expect(page.locator('[data-testid="fixture-badge"]:not([hidden])').first()).toBeVisible();
    await page.waitForTimeout(1500);
    await pressFixture(page, 'robot-hq');
    await expect(page.getByTestId('help-modal')).toBeVisible();
    await close(page);

    await page.locator('button[data-tool="board"]').click();
    await page.getByRole('button', { name: /^Later:/ }).click();
    await expect(page.getByRole('list', { name: 'Cards for later' })).toContainText('Plan the Harbor launch post');
  });
});
