import { addCard, cardState, drive, expect, test, type Page } from './preview-fixture.js';

/**
 * Board, notes, library, Jira and speech journeys in the preview hub: the real hub and website against fake servers, a
 * fake Jira site and a fake Luady that runs board cards through the hub's own tool route (preview/), on a desktop
 * window and on a phone.
 */

async function openTool(page: Page, kind: 'board' | 'notes' | 'library' | 'jira'): Promise<void> {
  await page.locator(`button[data-tool="${kind}"]`).click();
}

const close = (page: Page) => page.keyboard.press('Escape');
const stamp = (): string => Date.now().toString(36).slice(-5);

test.describe('desktop 1920×1080', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('the map fills the window; the board opens from its fixture and the top bar; a card opens', async ({ office: page }) => {
    const canvas = await page.locator('[data-testid="agency-page"] canvas').first().boundingBox();
    expect(canvas?.width).toBeGreaterThanOrEqual(1900);
    const badge = await page.locator('[data-fixture="board-hq"]').boundingBox();
    expect(badge).not.toBeNull();
    await page.mouse.click(badge!.x + badge!.width / 2, badge!.y + badge!.height + 6);
    await expect(page.getByTestId('board-modal')).toBeVisible();
    await close(page);
    await expect(page.getByTestId('modal-backdrop')).toHaveCount(0);
    await openTool(page, 'board');
    for (const lane of ['todo', 'running', 'needs', 'done']) await expect(page.locator(`article[data-lane="${lane}"]`).first()).toBeVisible();
    await page.locator('.paper-card__title').first().click();
    await expect(page.getByTestId('card-sheet')).toBeVisible();
    await close(page);
    await close(page);
    await expect(page.getByTestId('modal-backdrop')).toHaveCount(0);
  });

  test('add a card, then Run two: they go to Running and tick from the session\'s reports', async ({ office: page }) => {
    const tag = stamp();
    await openTool(page, 'board');
    await page.getByRole('button', { name: '+ Add' }).click();
    const added = `Added from the board ${tag}`;
    await page.getByLabel('Title').fill(added);
    await page.getByRole('button', { name: 'Add card' }).click();
    await expect(page.locator(`article[aria-label="${added}"]`)).toBeVisible();
    const titles = [`Round the totals ${tag}`, `Log failed payments ${tag}`];
    for (const title of titles) await addCard(page, { title, project: 'orders-api', server: 'birch' });
    for (const title of titles) await page.locator(`article[aria-label="${title}"] .paper-card__pick input`).check();
    await page.locator('.paper-btn--run').click();
    await expect(page.locator(`article[aria-label="${titles[0]}"][data-lane="running"]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`article[aria-label="${titles[1]}"][data-lane="done"]`)).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(`article[aria-label="${titles[1]}"]`)).toContainText('changed and tested in the preview');
  });

  test('Give to… opens the picker; a card dragged onto a character and onto a room goes to work', async ({ office: page }) => {
    const tag = stamp();
    await page.keyboard.press('1');
    await page.waitForTimeout(1200);
    const toCharacter = await addCard(page, { title: `Drag me ${tag}`, project: 'store-desk', server: 'birch' });
    const toRoom = await addCard(page, { title: `Drag to a room ${tag}`, project: 'menu-import', server: 'birch' });
    await openTool(page, 'board');
    await page.locator(`article[aria-label="Drag me ${tag}"] .paper-card__pick input`).check();
    await page.locator('.board-tray').getByRole('button', { name: 'Give to…' }).click();
    const picker = page.getByTestId('give-picker');
    await expect(picker.getByRole('button', { name: /Let Luady decide/ })).toBeVisible();
    await expect(picker.getByRole('button', { name: /A new session in Orchard/ })).toBeVisible();
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('.board-tray').getByRole('button', { name: 'Clear' }).click();

    const drag = async (title: string, to: () => Promise<{ x: number; y: number }>) => {
      const handle = page.locator(`article[aria-label="${title}"] .paper-card__grip`);
      await handle.scrollIntoViewIfNeeded();
      const grip = await handle.boundingBox();
      await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip!.x + 40, grip!.y + 40, { steps: 5 });
      await page.waitForTimeout(500);
      const target = await to();
      await page.mouse.move(target.x, target.y, { steps: 12 });
      await page.waitForTimeout(300);
      await page.mouse.up();
    };
    await drag(`Drag me ${tag}`, async () => {
      const plate = await page.locator('[data-plate="agent"]').filter({ hasText: 'store-desk' }).first().boundingBox();
      return { x: plate!.x + plate!.width / 2, y: plate!.y - 30 };
    });
    await expect.poll(() => cardState(page, toCharacter), { timeout: 10_000 }).not.toBe('open');
    // An empty stretch of the Orchard room's floor, below its plaque (the room is in view).
    await drag(`Drag to a room ${tag}`, async () => {
      const plaque = await page.locator('[data-testid="room-plaque"]').filter({ hasText: 'Orchard' }).first().boundingBox();
      return { x: plaque!.x + 380, y: plaque!.y + 470 };
    });
    await expect.poll(() => cardState(page, toRoom), { timeout: 10_000 }).not.toBe('open');
  });

  test('notes: the list, a meeting, and a new note sent to Luady shows his answer', async ({ office: page }) => {
    await openTool(page, 'notes');
    await page.locator('.notes-row').filter({ hasText: 'Orchard stand-up' }).click();
    await expect(page.getByText('Checkout v2 is on track').first()).toBeVisible();
    await page.getByRole('button', { name: 'New note' }).click();
    const form = page.getByRole('form', { name: 'New note' });
    const title = `Stand-up ${stamp()}`;
    await form.locator('input').first().fill(title);
    await form.locator('textarea').fill('Yesterday: fee bug found. Today: fix it.');
    await form.getByRole('button', { name: 'Send to Luady' }).click();
    await expect(page.getByText(`I read "${title}"`).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: `Follow up on "${title}"` }).or(page.getByText(`Follow up on "${title}"`)).first()).toBeVisible();
  });

  test('library: projects, knowledge pages with Sync now, and skills', async ({ office: page }) => {
    await openTool(page, 'library');
    await expect(page.getByRole('button', { name: /Open app-backend/ }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Knowledge' }).click();
    await expect(page.locator('.lib-book').filter({ hasText: 'How we work' })).toBeVisible();
    await page.getByRole('button', { name: /Sync now/ }).first().click();
    await page.getByRole('tab', { name: 'Skills' }).click();
    await expect(page.getByText('jira-ticket').first()).toBeVisible();
    await expect(page.getByText('board').first()).toBeVisible();
  });

  test('jira: the board in the Orchard room; a ticket moves, gets a comment, and Start building makes a card', async ({ office: page, preview }) => {
    await page.keyboard.press('1');
    await page.waitForTimeout(1200);
    const badge = await page.locator('[data-fixture="jira-birch"]').boundingBox();
    await page.mouse.click(badge!.x + badge!.width / 2, badge!.y + badge!.height + 6);
    await expect(page.getByText('Sprint 42 · Checkout').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('article[aria-label="ORC-1126"] .jira-card__open').click();
    const ticket = page.getByRole('complementary', { name: 'Ticket ORC-1126' });
    await expect(ticket).toBeVisible();
    await ticket.locator('select').first().selectOption({ label: 'Ready for review → In Review' });
    await ticket.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(ticket).toContainText('In Review', { timeout: 10_000 });
    await ticket.locator('textarea[placeholder="Add a comment…"]').fill('Looking at it now.');
    await ticket.getByRole('button', { name: 'Comment' }).click();
    await expect(ticket).toContainText('Looking at it now.');
    await ticket.getByRole('button', { name: 'Start building' }).click();
    await expect(page.getByText(/Luady is on it: ORC-1126/).first()).toBeVisible();
    await close(page);
    await drive(preview, 'jira-off', []);
    await openTool(page, 'jira');
    await expect(page.getByRole('form', { name: /Connect Jira/ })).toBeVisible({ timeout: 10_000 });
    await close(page);
    await drive(preview, 'jira-on', []);
  });

  test('speech, Luady\'s message flow, the chat dock and the activity pill', async ({ office: page, preview }) => {
    await drive(preview, 'say', ['birch/dev_orchard', 'The fee fix is on staging.']);
    await expect(page.getByTestId('agent-speech').filter({ hasText: 'The fee fix is on staging.' })).toBeVisible({ timeout: 10_000 });
    await drive(preview, 'report', ['cedar/meadow-hr', 'Payroll export is ready.']);
    await expect(page.getByTestId('agent-speech').filter({ hasText: 'Payroll export is ready.' })).toBeVisible({ timeout: 10_000 });

    const input = page.getByRole('textbox', { name: 'Message to Luady' });
    await input.fill('What is left for today?');
    await input.press('Enter');
    await expect(page.getByTestId('luady-pop')).toBeVisible();
    await expect(page.getByTestId('luady-answer')).toContainText('Preview Luady: got it.', { timeout: 15_000 });
    await drive(preview, 'luady-say', ['Three cards are done today.']);
    await expect(page.getByTestId('luady-answer')).toContainText('Three cards are done today.', { timeout: 10_000 });
    await expect(page.getByTestId('luady-answer')).not.toContainText('NO_UPDATE');

    await page.getByRole('button', { name: /Show the conversation/ }).click();
    await expect(page.getByRole('log', { name: 'Messages with Luady' })).toContainText('Three cards are done today.');
    await page.getByRole('button', { name: 'Hide the conversation' }).first().click();

    void drive(preview, 'steps', ['birch/app-frontend', '20']);
    void drive(preview, 'helper', ['cedar/fitness-demo']);
    await expect(page.getByTestId('activity-pill')).toContainText(/helper/, { timeout: 8_000 });
    await page.getByTestId('activity-pill').click();
    await expect(page.getByTestId('activity-modal').first()).toContainText('app-frontend');
    await close(page);
    await expect(page.locator('[data-testid="room-plaque"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="fixture-badge"]').first()).toBeVisible();
  });
});

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('the board, notes, library and Jira open from the top bar as sheets; Run works one lane at a time', async ({ office: page }) => {
    const tag = stamp();
    const titles = [`Phone run one ${tag}`, `Phone run two ${tag}`];
    for (const title of titles) await addCard(page, { title, project: 'orders-api', server: 'birch' });
    await openTool(page, 'board');
    const lanes = page.locator('.board-switch__lane');
    await expect(lanes).toHaveCount(4);
    for (const title of titles) await page.locator(`article[aria-label="${title}"] .paper-card__pick input`).check();
    await page.locator('.paper-btn--run').click();
    await lanes.nth(3).click();
    await expect(page.locator(`article[aria-label="${titles[1]}"][data-lane="done"]`)).toBeVisible({ timeout: 30_000 });
    await close(page);

    await openTool(page, 'notes');
    await expect(page.locator('.notes-row').first()).toBeVisible();
    await close(page);
    await openTool(page, 'library');
    await expect(page.getByRole('tab', { name: 'Skills' })).toBeVisible();
    await close(page);
    await openTool(page, 'jira');
    await expect(page.getByText('Sprint 42 · Checkout').first()).toBeVisible({ timeout: 15_000 });
    await close(page);
  });

  test('a speech bubble, Luady\'s answer and the chat dock as a sheet', async ({ office: page, preview }) => {
    await drive(preview, 'say', ['local/picture-desk', 'The poster is ready.']);
    await expect(page.getByTestId('agent-speech').filter({ hasText: 'The poster is ready.' }).or(page.getByTestId('speech-mark')).first()).toBeAttached({ timeout: 10_000 });
    await drive(preview, 'luady-say', ['Morning! Two cards wait for you.']);
    await expect(page.getByTestId('luady-answer')).toContainText('Two cards wait for you.', { timeout: 10_000 });
    await page.getByRole('button', { name: /Show the conversation/ }).click();
    await expect(page.getByRole('log', { name: 'Messages with Luady' })).toContainText('Two cards wait for you.');
  });
});
