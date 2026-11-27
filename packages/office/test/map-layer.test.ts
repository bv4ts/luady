import { describe, expect, it } from 'vitest';
import { darken, hexToRgb } from '../src/colors.js';
import { classicRooms, CLASSIC_PALETTES } from './rooms-fixture.js';
import { buildOffice } from '../src/layout.js';
import { hashBytes } from '../src/looks.js';
import { pixelAt } from '../src/raster.js';
import { mapLayerRaster } from '../src/sprites/map-layer.js';
import { HQ_PALETTE } from '../src/teams.js';

const rgba = (hex: string): readonly number[] => [...hexToRgb(hex), 255];
const tileCentre = (tx: number, ty: number): readonly [number, number] => [tx * 16 + 8, ty * 16 + 8];
const FACE = '#39435a';

describe('mapLayerRaster with every server', () => {
  const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
  const layer = mapLayerRaster(map);
  const at = (x: number, y: number): readonly number[] => pixelAt(layer, x, y);

  it('covers the whole map', () => {
    expect([layer.width, layer.height]).toEqual([1344, 672]);
  });

  it('leaves everything outside the building transparent: no void, no dot grid, no shadow block', () => {
    [[0, 0], [8, 8], [5, 100], [1340, 100], [1335, 662], [700, 668], [8, 300], [1340, 380], [1336, 600]].forEach(([x, y]) => expect([x, y, at(x ?? 0, y ?? 0)[3]]).toEqual([x, y, 0]));
    let opaque = 0;
    for (let x = 0; x < 1344; x += 1) if (at(x, 664)[3] !== 0 || at(x, 4)[3] !== 0) opaque += 1;
    expect(opaque).toBe(0);
  });

  it('paints the whole building and both entries', () => {
    [[16, 16], [1327, 16], [16, 655], [1327, 655], [672, 336]].forEach(([x, y]) => expect(at(x ?? 0, y ?? 0)[3]).toBe(255));
    expect(at(...tileCentre(0, 20))[3]).toBe(255);
    expect(at(...tileCentre(83, 21))[3]).toBe(255);
  });

  it('tints each room floor with its team', () => {
    expect(at(...tileCentre(5, 5))).not.toEqual(at(...tileCentre(64, 5)));
    expect(at(...tileCentre(5, 5))).not.toEqual(at(...tileCentre(5, 30)));
  });

  it('opens each server room with a door in its colour', () => {
    expect(at(...tileCentre(21, 17))).toEqual(rgba(darken(CLASSIC_PALETTES.rose.base, 0.12)));
    expect(at(...tileCentre(61, 24))).toEqual(rgba(darken(CLASSIC_PALETTES.pv.base, 0.12)));
  });

  it('opens HQ to both corridors', () => {
    expect(at(...tileCentre(27, 20))).toEqual(rgba(darken(HQ_PALETTE.base, 0.12)));
    expect(at(...tileCentre(56, 21))).toEqual(rgba(darken(HQ_PALETTE.base, 0.12)));
  });

  it('hangs a board in the room team colour', () => {
    expect(at(1004, 32)).toEqual(rgba(CLASSIC_PALETTES.amber.base));
    expect(at(268, 400)).toEqual(rgba(CLASSIC_PALETTES.jade.base));
  });

  it('paints no cork board and no bookshelf in HQ: they are fixtures', () => {
    expect(at(470, 30)).toEqual(rgba(FACE));
    expect(at(536, 30)).toEqual(rgba(FACE));
  });

  it('lays a rug in the rooms that have one', () => {
    expect(at(...tileCentre(69, 13))).not.toEqual(at(...tileCentre(69, 9)));
  });

  it('draws the same pixels every time', () => {
    const again = mapLayerRaster(map);
    expect(again.data === layer.data).toBe(false);
    expect(again.data.length).toBe(layer.data.length);
    expect(again.data.every((v, i) => v === layer.data[i])).toBe(true);
  });

  it('matches the pinned picture', () => {
    expect(hashBytes(layer.data)).toBe(PINNED);
  });
});

describe('mapLayerRaster with Jira boards', () => {
  const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));

  it('leaves the wall bare where a room hangs its Jira board, and paints the others', () => {
    const layer = mapLayerRaster(map, { jiraRooms: ['ash'] });
    expect(pixelAt(layer, 1004, 32)).toEqual(rgba(FACE));
    expect(pixelAt(layer, 268, 400)).toEqual(rgba(CLASSIC_PALETTES.jade.base));
  });

  it('is the plain picture when no room has Jira', () => {
    expect(hashBytes(mapLayerRaster(map, { jiraRooms: [] }).data)).toBe(hashBytes(mapLayerRaster(map).data));
  });
});

describe('mapLayerRaster with lots', () => {
  const layer = mapLayerRaster(buildOffice(classicRooms(['birch'])));
  const at = (x: number, y: number): readonly number[] => pixelAt(layer, x, y);

  it('gives a lot a dark floor', () => {
    expect(at(...tileCentre(64, 5))).toEqual(rgba('#141925'));
    expect(at(...tileCentre(69, 13))).toEqual(rgba('#141925'));
    expect(at(...tileCentre(10, 30))).toEqual(rgba('#141925'));
  });

  it('keeps the wall closed where a lot would have its door', () => {
    expect(at(...tileCentre(61, 17))).toEqual(rgba('#151a27'));
    expect(at(...tileCentre(21, 17))).toEqual(rgba(darken(CLASSIC_PALETTES.rose.base, 0.12)));
  });

  it('hangs no board in a lot', () => {
    expect(at(1004, 32)).not.toEqual(rgba(CLASSIC_PALETTES.amber.base));
  });
});

/** FNV-1a of the four-server map layer. Change it only for a deliberate visual change. */
const PINNED = 1898176028;
