import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fake from './fake-pixi.js';

vi.mock('pixi.js/unsafe-eval', () => ({}));
vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const { SHEET_TIMEOUT_MS, loadCharacterSheet } = await import('../../../../src/features/agency/scene/character-sheet.js');

const image = (): HTMLImageElement => Object.assign(document.createElement('img'), { width: 470, height: 236 });

beforeEach(() => {
  fake.resetFakePixi();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadCharacterSheet', () => {
  it('builds a nearest-scaled sprite sheet from the bundled picture and frame list', async () => {
    const img = image();
    const load = vi.fn(async (_url: string) => img);
    const sheet = await loadCharacterSheet(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(String(load.mock.calls[0]?.[0])).toMatch(/characters.*\.png/);
    const made = fake.Spritesheet.instances[0];
    const source = made?.texture.source as InstanceType<typeof fake.ImageSource>;
    expect(source.options).toMatchObject({ resource: img, scaleMode: 'nearest' });
    expect(Object.keys(made?.data.frames ?? {})).toHaveLength(162);
    expect(sheet?.frame('bun', 'rose', 'idle')?.label).toBe('bun_rose_idle');
    expect(sheet?.frame('manager', 'hq', 'blink')?.label).toBe('manager_hq_blink');
    expect(sheet?.frame('mini', 'amber', 'step')?.label).toBe('mini_amber_step');
    expect(sheet?.frame('ghost', 'mute', 'idle')?.label).toBe('ghost_mute_idle');
  });

  it('gives null for a frame the sheet does not have', async () => {
    const sheet = await loadCharacterSheet(async () => image());
    expect(sheet?.frame('bun', 'nope' as never, 'idle')).toBeNull();
  });

  it('gives null (code-drawn characters) when the picture cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(loadCharacterSheet(async () => { throw new Error('404'); })).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('gives up after a while instead of holding the office back', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = loadCharacterSheet(() => new Promise<HTMLImageElement>(() => undefined));
    await vi.advanceTimersByTimeAsync(SHEET_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
  });

  it('destroys its frames and the picture', async () => {
    const sheet = await loadCharacterSheet(async () => image());
    const frame = sheet?.frame('bot', 'amber', 'idle') as unknown as InstanceType<typeof fake.Texture>;
    sheet?.destroy();
    expect(frame.destroyed).toBe(true);
    expect(fake.Spritesheet.instances[0]?.destroyedBase).toBe(true);
  });
});
