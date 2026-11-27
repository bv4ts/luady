import { describe, expect, it } from 'vitest';
import { hexToRgb } from '../src/colors.js';
import { pixelAt, type Raster } from '../src/raster.js';
import { FIXTURE_SIZE } from '../src/fixtures.js';
import { FURNITURE_KINDS, FURNITURE_SIZE, furnitureRaster, monitorScreen } from '../src/sprites/furniture.js';
import { CLASSIC_PALETTES } from './rooms-fixture.js';

const rgba = (hex: string): readonly number[] => [...hexToRgb(hex), 255];
const colours = (r: Raster): ReadonlySet<string> => {
  const out = new Set<string>();
  for (let i = 0; i < r.data.length; i += 4) out.add(Array.from(r.data.subarray(i, i + 4)).join());
  return out;
};
const has = (r: Raster, hex: string): boolean => colours(r).has(rgba(hex).join());

describe('furnitureRaster', () => {
  it('knows the twenty-seven kinds', () => {
    expect([...FURNITURE_KINDS].sort()).toEqual([
      'board', 'card', 'clock', 'coffee', 'cooler', 'desk', 'envelope', 'folder', 'fuse', 'jira', 'library', 'links', 'luadydesk', 'meeting',
      'monitor', 'notes', 'plant', 'rack', 'readbench', 'robot', 'schedule', 'sofa', 'table', 'tv', 'versions', 'wins', 'workbench',
    ]);
    expect(Object.keys(FURNITURE_SIZE).sort()).toEqual([...FURNITURE_KINDS].sort());
  });

  it.each(FURNITURE_KINDS)('draws %s at exactly its size, with something on it', (kind) => {
    const r = furnitureRaster(kind);
    expect({ w: r.width, h: r.height }).toEqual(FURNITURE_SIZE[kind]);
    expect(colours(r).size).toBeGreaterThan(1);
  });

  it('draws the desk with its lit top edge and dark base line', () => {
    const desk = furnitureRaster('desk');
    expect([desk.width, desk.height]).toEqual([48, 18]);
    expect(pixelAt(desk, 0, 0)).toEqual(rgba('#e6d9c1'));
    expect(pixelAt(desk, 0, 1)).toEqual(rgba('#c9b79a'));
    expect(pixelAt(desk, 0, 17)).toEqual(rgba('#4a3c2c'));
  });

  it('has the fixed size of each furniture kind', () => {
    expect(FURNITURE_SIZE.rack).toEqual({ w: 30, h: 46 });
    expect(FURNITURE_SIZE.monitor).toEqual({ w: 16, h: 14 });
    expect(FURNITURE_SIZE.luadydesk).toEqual({ w: 64, h: 34 });
    expect(FURNITURE_SIZE.envelope).toEqual({ w: 11, h: 8 });
    expect(Object.isFrozen(FURNITURE_SIZE)).toBe(true);
  });

  it('leaves the gaps in the art transparent', () => {
    expect(pixelAt(furnitureRaster('plant'), 0, 0)[3]).toBe(0);
    expect(pixelAt(furnitureRaster('table'), 0, 0)[3]).toBe(0);
    expect(pixelAt(furnitureRaster('rack'), 0, 0)).toEqual(rgba('#0e121b'));
  });

  it('gives the same pixels every time', () => {
    expect(furnitureRaster('library').data).toEqual(furnitureRaster('library').data);
  });

  it('draws every fixture at its fixture size', () => {
    (Object.keys(FIXTURE_SIZE) as (keyof typeof FIXTURE_SIZE)[]).forEach((kind) => expect(FURNITURE_SIZE[kind]).toEqual(FIXTURE_SIZE[kind]));
    expect(FIXTURE_SIZE).toMatchObject({ board: { w: 144, h: 30 }, library: { w: 132, h: 32 }, fuse: { w: 20, h: 26 }, jira: { w: 62, h: 18 } });
  });

  it('paints the Jira board in Jira blue and the board with a wooden frame round cork', () => {
    expect(has(furnitureRaster('jira'), '#0052cc')).toBe(true);
    const board = furnitureRaster('board');
    expect(pixelAt(board, 2, 2)).toEqual(rgba('#7a5434'));
    expect(has(board, '#b4875a') && has(board, '#e23a2e')).toBe(true);
    expect(colours(board).size).toBeGreaterThan(8);
  });

  it('draws the teal note taker beside the notes desk', () => {
    expect(has(furnitureRaster('notes'), '#3cc3b0')).toBe(true);
  });

  it('lights the versions screen with a few lines', () => {
    const screen = furnitureRaster('versions');
    expect(colours(screen).size).toBeGreaterThan(5);
    expect(has(screen, '#54d38a')).toBe(true);
  });
});

describe('monitorScreen', () => {
  it('is 14 x 9 for every glow', () => {
    (['off', 'work', 'alert', 'error'] as const).forEach((glow) => {
      const r = monitorScreen(glow, CLASSIC_PALETTES.rose);
      expect([r.width, r.height]).toEqual([14, 9]);
      expect(Array.from({ length: r.data.length / 4 }, (_, i) => r.data[i * 4 + 3]).every((a) => a === 255)).toBe(true);
    });
  });

  it('is dark when off', () => {
    expect([...colours(monitorScreen('off', CLASSIC_PALETTES.rose))]).toEqual([rgba('#0b101c').join()]);
  });

  it('shows three lines in the team colour while working', () => {
    const r = monitorScreen('work', CLASSIC_PALETTES.jade);
    expect(has(r, '#0b101c')).toBe(true);
    expect(has(r, CLASSIC_PALETTES.jade.base)).toBe(true);
    const lineRows = Array.from({ length: 9 }, (_, y) => y).filter((y) => Array.from({ length: 14 }, (_, x) => x).some((x) => pixelAt(r, x, y).join() === rgba(CLASSIC_PALETTES.jade.base).join()));
    expect(lineRows).toHaveLength(3);
  });

  it('is red with a white mark when it needs the owner', () => {
    const r = monitorScreen('alert', CLASSIC_PALETTES.rose);
    expect(pixelAt(r, 0, 0)).toEqual(rgba('#e23a2e'));
    expect(has(r, '#ffffff')).toBe(true);
  });

  it('is dark red with a red cross on error', () => {
    const r = monitorScreen('error', CLASSIC_PALETTES.rose);
    expect(pixelAt(r, 0, 0)).toEqual(rgba('#3a0d0d'));
    expect(has(r, '#e23a2e')).toBe(true);
  });
});
