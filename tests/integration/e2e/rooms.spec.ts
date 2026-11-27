import { test, expect, type Locator, type Page } from '@playwright/test';
import { openOffice, roomsOnPage, startDemoOffice, type DemoHandle } from './demo-fixture.js';

/**
 * Rooms in Settings (the demo's classic office): add a room, rename one, recolour one, reorder by dragging and
 * with "Move to…", and remove one with its links moved to another room. Each change is read back from the hub.
 */

interface Link { readonly id: number; readonly server: string; readonly label: string }

async function linksOnPage(page: Page): Promise<Link[]> {
  return page.evaluate(async () => {
    const key = localStorage.getItem('hub.pageKey');
    const res = await fetch('/api/links', { headers: key === null ? {} : { 'x-hub-key': key } });
    return ((await res.json()) as { items: Link[] }).items;
  });
}

const order = async (page: Page): Promise<string[]> => (await roomsOnPage(page)).toSorted((a, b) => a.position - b.position).map((room) => room.id);
const roomOf = async (page: Page, id: string) => (await roomsOnPage(page)).find((room) => room.id === id);

let demo: DemoHandle | null = null;

test.beforeAll(async () => {
  demo = await startDemoOffice('classic');
  await demo.ready;
});
test.afterAll(async () => {
  await demo?.stop();
});

test.describe.configure({ timeout: 180_000 });

test('rooms: add, rename, recolour, reorder by drag and by "Move to…", and remove with the links moved', async ({ page }) => {
  if (demo === null) throw new Error('the demo did not start');
  await openOffice(page, demo);
  await page.goto(`${demo.url}/settings`);
  const section = page.getByTestId('rooms-section');
  const rows = section.getByTestId('room-row');
  const row = (id: string): Locator => section.locator(`[data-testid="room-row"][data-room="${id}"]`);
  await expect(rows).toHaveCount(4);
  expect(await order(page)).toEqual(['birch', 'ash', 'cedar', 'local']);
  let garden = '';

  await test.step('add a project room', async () => {
    await section.getByRole('button', { name: 'Add a room' }).click();
    const editor = section.getByTestId('room-editor');
    await editor.getByRole('radio', { name: /A project/ }).check();
    await editor.getByLabel('Name', { exact: true }).fill('Garden');
    await editor.getByRole('button', { name: 'Add a project' }).click();
    await editor.getByLabel('Project name 1').fill('garden-*');
    await editor.getByRole('button', { name: 'Add the room' }).click();
    await expect(rows).toHaveCount(5);
    await expect.poll(async () => (await roomsOnPage(page)).find((room) => room.name === 'Garden')?.position).toBe(4);
    garden = (await roomsOnPage(page)).find((room) => room.name === 'Garden')?.id ?? '';
    await expect(row(garden)).toContainText('Garden');
  });

  await test.step('rename Orchard', async () => {
    await row('birch').getByRole('button', { name: 'Edit Orchard' }).click();
    const editor = section.getByTestId('room-editor');
    await editor.getByLabel('Name', { exact: true }).fill('Orchard Labs');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(row('birch')).toContainText('Orchard Labs');
    await expect.poll(async () => (await roomOf(page, 'birch'))?.name).toBe('Orchard Labs');
  });

  await test.step('recolour Harbor', async () => {
    const before = (await roomOf(page, 'ash'))?.colour;
    await row('ash').getByRole('button', { name: 'Edit Harbor' }).click();
    const editor = section.getByTestId('room-editor');
    const swatch = editor.getByRole('radiogroup', { name: 'Room colours' }).locator('[role="radio"][aria-checked="false"]').first();
    const hex = (await swatch.getAttribute('data-hex')) ?? '';
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex).not.toBe(before);
    await swatch.click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByTestId('room-editor')).toHaveCount(0);
    await expect.poll(async () => (await roomOf(page, 'ash'))?.colour).toBe(hex);
  });

  await test.step('reorder by dragging Meadow onto Orchard Labs', async () => {
    await row('cedar').dragTo(row('birch'));
    await expect.poll(() => order(page)).toEqual(['cedar', 'birch', 'ash', 'local', garden]);
    await expect(rows.first()).toHaveAttribute('data-room', 'cedar');
  });

  await test.step('move Private Projects to a free spot with "Move to…"', async () => {
    await row('local').getByRole('button', { name: 'Move Private Projects to another spot' }).click();
    const select = section.getByLabel('Move Private Projects to', { exact: true });
    const free = select.locator('option', { hasText: '(free)' }).first();
    const spot = Number(await free.getAttribute('value'));
    await select.selectOption(String(spot));
    await section.getByRole('group', { name: 'Move Private Projects' }).getByRole('button', { name: 'Move', exact: true }).click();
    await expect.poll(async () => (await roomOf(page, 'local'))?.position).toBe(spot);
    await expect(row('local').locator('.room-row__spot')).toHaveText(String(spot + 1));
  });

  await test.step('remove Meadow and move its links to Harbor', async () => {
    const meadowLinks = (await linksOnPage(page)).filter((link) => link.server === 'cedar');
    expect(meadowLinks.length).toBeGreaterThan(0);
    await row('cedar').getByRole('button', { name: 'Remove Meadow' }).click();
    const dialog = section.getByTestId('room-delete');
    await expect(dialog.getByRole('radio', { name: 'Move them to another room' })).toBeChecked();
    await dialog.getByLabel('Move them to', { exact: true }).selectOption('ash');
    await dialog.getByRole('button', { name: 'Remove the room' }).click();
    await expect(row('cedar')).toHaveCount(0);
    await expect.poll(async () => (await roomsOnPage(page)).map((room) => room.id)).not.toContain('cedar');
    const after = await linksOnPage(page);
    for (const link of meadowLinks) expect(after.find((moved) => moved.id === link.id)?.server, link.label).toBe('ash');
    expect(after.filter((link) => link.server === 'cedar')).toEqual([]);
  });
});
