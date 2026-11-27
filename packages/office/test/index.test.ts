import { describe, expect, it } from 'vitest';
import * as office from '../src/index.js';

describe('@luady/office barrel', () => {
  it.each([
    'TILE', 'mix', 'lighten', 'darken', 'hexToRgb', 'paletteFor',
    'HQ_RECT', 'buildOffice', 'roomRectPx', 'roomAtPx',
    'DESK_CAPACITY', 'deskModeFor', 'slotsFor', 'propsFor', 'walkGrid', 'findPath', 'tileKey',
    'assignSeats', 'hashId', 'lookFor', 'IDLE_SLEEP_MS', 'SILENT_WARN_MS', 'visualFor', 'toolKind',
    'createRaster', 'fillRect', 'blit', 'pixelAt', 'paint', 'critterRaster', 'bubbleRaster', 'SPECIES_SIZE',
    'furnitureRaster', 'FURNITURE_SIZE', 'monitorScreen', 'buildSnapshot',
    'ambienceAt', 'panesOf', 'glowPoolRaster', 'lampFeet',
    'HQ_X', 'HQ_W', 'EAST_X', 'fixturesFor', 'FIXTURE_KINDS', 'FIXTURE_SIZE', 'groundRaster', 'EXTERIOR_MARGIN', 'GROUND_TILE',
    'HQ_ID', 'LOT_PREFIX', 'HQ_PALETTE', 'MUTE_PALETTE',
    'OFFICE_MEMO_LIMIT', 'lotRoom', 'isFurnished', 'isEmptySlot', 'visualKeyOf', 'orientationOf', 'walkMask', 'ownerMinutes',
    'CHUNK_PX', 'CHUNK_LAYERS', 'chunkGridFor', 'chunkRect', 'chunkWorldRect', 'chunkPlacement', 'chunkLayers', 'chunkRaster', 'chunkKey',
    'layerExtent', 'downsample', 'cropRaster', 'drawMap', 'daylightBoxes',
    'ROOM_W', 'ROOM_H', 'STREET_H', 'BAND_H', 'MARGIN', 'geometryFor', 'geometryOf', 'FIRST_RING', 'slotIndexOf', 'slotIndexAt',
    'slotsMeeting', 'roomRectOf', 'POSITION_LIMIT', 'roomsMeeting', 'roomInSlot', 'paintWindow', 'mapLayerWindow', 'daylightWindow',
    'drawDaylight', 'exteriorFrame', 'drawExterior', 'lastPathVisits', 'walkMaskBuilds',
  ])('re-exports %s', (name) => {
    expect(office[name as keyof typeof office]).toBeDefined();
  });

  it.each(['mapLayerRaster', 'daylightRaster', 'exteriorRaster'])('keeps the full-size oracle %s out of the entry (the scene paints chunks)', (name) => {
    expect(name in office).toBe(false);
  });
});
