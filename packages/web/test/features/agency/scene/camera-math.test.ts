import { HQ_ID, buildOffice, roomRectPx, type PixelRect } from '@luady/office';
import { describe, expect, it } from 'vitest';
import {
  BAND_PX, FOCUS_MIN, MAX_ZOOM, ONE_ROOM_W, OVERVIEW_MIN, PAN_MARGIN, WIDE_RATIO, aimFor, clampCenter, fitRect, fitZoom, focusRect, viewCenter,
  wholeOfficeFit, type CameraFit,
} from '../../../../src/features/agency/scene/camera-math.js';
import { FAR_SCALE, isFar, lodFor } from '../../../../src/features/agency/scene/live-set.js';
import { stageInsets } from '../../../../src/features/agency/panels/insets.js';
import type { StageInsets } from '../../../../src/features/agency/stage-types.js';
import { many, roomsOf, session, snap } from './office-fixtures.js';

const NONE: StageInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const BARS: StageInsets = { top: 56, right: 0, bottom: 64, left: 0 };
type View = { width: number; height: number };

/** Where a world rectangle lands on screen when `fit` puts its point at the centre of the free area. */
const onScreen = (r: PixelRect, fit: CameraFit, view: View, insets: StageInsets) => {
  const center = viewCenter(fit, insets);
  return {
    left: (r.x - center.x) * fit.scale + view.width / 2,
    top: (r.y - center.y) * fit.scale + view.height / 2,
    right: (r.x + r.w - center.x) * fit.scale + view.width / 2,
    bottom: (r.y + r.h - center.y) * fit.scale + view.height / 2,
  };
};

/** True when `r` lies inside the free area of the view once `fit` is applied. */
const inside = (r: PixelRect, fit: CameraFit, view: View, insets: StageInsets): boolean => {
  const box = onScreen(r, fit, view, insets);
  const e = 1e-6;
  return box.left >= insets.left - e && box.right <= view.width - insets.right + e && box.top >= insets.top - e && box.bottom <= view.height - insets.bottom + e;
};

describe('the whole-office view', () => {
  const office = snap(many('birch', 1));
  const building = office.map.zones.all;

  it('takes the world size from the snapshot: the building is 1312 × 640 inside a 1344 × 672 map', () => {
    expect([office.map.width, office.map.height]).toEqual([1344, 672]);
    expect(building).toEqual({ x: 16, y: 16, w: 1312, h: 640 });
  });

  it.each([
    ['1920×1080', { width: 1920, height: 1080 }, 1920 / 1312],
    ['1366×768', { width: 1366, height: 768 }, (768 - 120) / 640],
    ['1512×982', { width: 1512, height: 982 }, 1512 / 1312],
  ] as const)('fits the building on a wide %s screen with no rounding down and no cap at 2', (_name, view, scale) => {
    const fit = wholeOfficeFit(office.map, view, BARS);
    expect(fit.scale).toBeCloseTo(scale, 9);
    expect(inside(building, fit, view, BARS)).toBe(true);
    expect({ x: fit.x, y: fit.y }).toEqual({ x: 672, y: 336 });
    const box = onScreen(building, fit, view, BARS);
    const fillsWidth = Math.abs(box.left - 0) < 1e-6 && Math.abs(box.right - view.width) < 1e-6;
    const fillsHeight = Math.abs(box.top - BARS.top) < 1e-6 && Math.abs(box.bottom - (view.height - BARS.bottom)) < 1e-6;
    expect(fillsWidth || fillsHeight).toBe(true);
  });

  it('zooms past 2 on a big screen', () => {
    expect(wholeOfficeFit(office.map, { width: 3840, height: 2160 }, BARS).scale).toBeCloseTo(3840 / 1312, 9);
  });

  it('opens a 390×844 phone at full height and one room wide, centred on HQ', () => {
    const view = { width: 390, height: 844 };
    const fit = wholeOfficeFit(office.map, view, BARS);
    expect((390 / (844 - 120))).toBeLessThan(WIDE_RATIO);
    expect(fit.scale).toBeCloseTo(390 / ONE_ROOM_W, 9);
    const hq = office.map.zones.hq;
    expect(fit.x).toBe(hq.x + hq.w / 2);
    const box = onScreen(building, fit, view, BARS);
    expect(box.top).toBeGreaterThanOrEqual(BARS.top - 1e-6);
    expect(box.bottom).toBeLessThanOrEqual(view.height - BARS.bottom + 1e-6);
    expect(390 / fit.scale).toBeGreaterThanOrEqual(ONE_ROOM_W - 1e-6);
  });

  it('opens a short, narrow free area at full height, never farther out than the fit', () => {
    const view = { width: 400, height: 900 };
    const fit = wholeOfficeFit(office.map, view, { ...BARS, bottom: 400 });
    expect(fit.scale).toBeCloseTo((900 - 56 - 400) / 640, 9);
    const tiny = wholeOfficeFit(office.map, { width: 200, height: 2000 }, NONE);
    expect(tiny.scale).toBeGreaterThanOrEqual(fitZoom(office.map, { width: 200, height: 2000 }, NONE));
  });

  it('is what the camera aims at for the all focus', () => {
    const view = { width: 1366, height: 768 };
    expect(aimFor(office, { kind: 'all' }, view, BARS)).toEqual(wholeOfficeFit(office.map, view, BARS));
  });

  it('measures one room and one band from the room template, as the classic corners did', () => {
    expect([ONE_ROOM_W, BAND_PX, OVERVIEW_MIN]).toEqual([416, 640, 0.45]);
  });

  it.each([
    ['1920×1080', { width: 1920, height: 1080 }],
    ['1366×768', { width: 1366, height: 768 }],
    ['390×844', { width: 390, height: 844 }],
    ['400×900', { width: 400, height: 900 }],
  ] as const)('gives the classic four built from rooms the same view as today on %s', (_name, view) => {
    expect(wholeOfficeFit(buildOffice(roomsOf(4)), view, BARS)).toEqual(wholeOfficeFit(office.map, view, BARS));
  });
});

describe('the band rule for bigger offices', () => {
  const laptop = { width: 1440, height: 900 };

  it('fits up to 24 rooms whole on a laptop', () => {
    const map = buildOffice(roomsOf(24));
    const fit = wholeOfficeFit(map, laptop, BARS);
    expect(fit.scale).toBeCloseTo(fitZoom(map, laptop, BARS), 9);
    expect(fit.scale).toBeGreaterThanOrEqual(OVERVIEW_MIN);
    expect({ x: fit.x, y: fit.y }).toEqual({ x: map.zones.all.x + map.zones.all.w / 2, y: map.zones.all.y + map.zones.all.h / 2 });
  });

  it.each([100, 300] as const)('opens %i rooms on the HQ row when the whole-office fit is below 0.45', (n) => {
    const map = buildOffice(roomsOf(n));
    expect(fitZoom(map, laptop, BARS)).toBeLessThan(OVERVIEW_MIN);
    const fit = wholeOfficeFit(map, laptop, BARS);
    expect(fit.scale).toBe(OVERVIEW_MIN);
    const { hq, hqRow } = map.zones;
    expect({ x: fit.x, y: fit.y }).toEqual({ x: hq.x + hq.w / 2, y: hqRow.y + hqRow.h / 2 });
  });

  it('never opens a wide screen farther out than the fit, nor closer than one band high', () => {
    const map = buildOffice(roomsOf(300));
    const short = { width: 1440, height: 300 };
    expect(wholeOfficeFit(map, short, BARS).scale).toBeCloseTo((300 - 120) / BAND_PX, 9);
  });

  it.each([0, 1, 4, 5, 24, 100, 300] as const)('opens a 390×844 phone the same way with %i rooms: one band high, one room wide, on HQ', (n) => {
    const map = buildOffice(roomsOf(n));
    const fit = wholeOfficeFit(map, { width: 390, height: 844 }, BARS);
    expect(fit.scale).toBeCloseTo(390 / ONE_ROOM_W, 9);
    expect(fit.x).toBe(map.zones.hq.x + map.zones.hq.w / 2);
    expect(fit.y).toBe(336);
  });
});

describe('lodFor', () => {
  it('gives 1 from 0.75, 2 from 0.45, 4 from 0.225 and 8 below', () => {
    expect([4, 1, 0.75, 0.7499, 0.45, 0.4499, 0.225, 0.2249, 0.05].map(lodFor)).toEqual([1, 1, 1, 2, 2, 4, 4, 8, 8]);
  });
});

describe('zoom limits', () => {
  const office = snap([]);

  it('lets the owner zoom out only as far as the fit, and in to 4', () => {
    expect(MAX_ZOOM).toBe(4);
    expect(fitZoom(office.map, { width: 1920, height: 1080 }, BARS)).toBeCloseTo(1920 / 1312, 9);
    expect(fitZoom(office.map, { width: 390, height: 844 }, BARS)).toBeCloseTo(390 / 1312, 9);
    expect(fitZoom(office.map, { width: 20000, height: 20000 }, NONE)).toBe(4);
  });

  it('lets the owner zoom out to the whole building at any size, far below the far-mode zoom', () => {
    const map = buildOffice(roomsOf(300));
    expect(fitZoom(map, { width: 390, height: 844 }, BARS)).toBeCloseTo(390 / map.zones.all.w, 9);
    expect(fitZoom(map, { width: 390, height: 844 }, BARS)).toBeLessThan(0.1);
  });
});

describe('fitRect and focus views', () => {
  const office = snap([session('cedar:a'), ...many('birch', 2)]);

  it('fits a rectangle without rounding, up to the maximum', () => {
    const r = { x: 0, y: 0, w: 100, h: 100 };
    expect(fitRect(r, { width: 350, height: 350 }, NONE, 10).scale).toBe(3.5);
    expect(fitRect(r, { width: 350, height: 350 }, NONE, 2.6).scale).toBe(2.6);
  });

  it('frames a room with a one-tile margin, and HQ as the whole HQ room with the same margin', () => {
    const room = roomRectPx(office.map.rooms.cedar!);
    expect(focusRect(office, { kind: 'room', room: 'cedar' })).toEqual({ x: room.x - 16, y: room.y - 16, w: room.w + 32, h: room.h + 32 });
    const hq = roomRectPx(office.map.rooms.hq!);
    expect(office.map.zones.hq).toEqual(hq);
    expect(focusRect(office, { kind: 'room', room: 'hq' })).toEqual({ x: hq.x - 16, y: hq.y - 16, w: hq.w + 32, h: hq.h + 32 });
    expect(focusRect(office, { kind: 'room', room: 'nowhere' })).toEqual(office.map.zones.all);
  });

  it('keeps all of HQ, its north wall included, below the top bar', () => {
    [{ width: 1920, height: 1080 }, { width: 390, height: 844 }, { width: 1280, height: 800 }].forEach((view) => {
      const fit = aimFor(office, { kind: 'room', room: 'hq' }, view, BARS);
      expect(inside(roomRectPx(office.map.rooms.hq!), fit, view, BARS)).toBe(true);
    });
  });

  it('fits one room fully inside the free area left of a 360 px panel', () => {
    const view = { width: 1280, height: 800 };
    const insets = { top: 56, right: 360, bottom: 64, left: 0 };
    const fit = aimFor(office, { kind: 'room', room: 'birch' }, view, insets);
    expect(inside(roomRectPx(office.map.rooms.birch!), fit, view, insets)).toBe(true);
  });

  it('frames 12 × 8 tiles around an actor seat, Luady included', () => {
    const sit = office.actors['cedar:a']!.sit;
    const r = focusRect(office, { kind: 'actor', id: 'cedar:a' });
    expect({ w: r.w, h: r.h }).toEqual({ w: 192, h: 128 });
    expect(r.x + r.w / 2).toBe(sit.x);
    const luady = focusRect(office, { kind: 'actor', id: 'manager' });
    expect(luady.x + luady.w / 2).toBe(office.map.spots.luadySit.x);
  });

  it('falls back to the last known room of an actor that is gone, else the whole office', () => {
    const gone = snap(many('birch', 2), { previous: office });
    expect(focusRect(gone, { kind: 'actor', id: 'cedar:a' }, 'cedar')).toEqual(focusRect(gone, { kind: 'room', room: 'cedar' }));
    expect(focusRect(gone, { kind: 'actor', id: 'cedar:a' })).toEqual(gone.map.zones.all);
  });
});

describe('a focused room is always drawn in detail', () => {
  const office = snap([session('cedar:a'), ...many('birch', 2)]);
  const phone = { width: 390, height: 844 };
  const sheet = stageInsets(phone, true);

  it('zooms no farther out than the far-mode zoom', () => {
    expect(FOCUS_MIN).toBe(FAR_SCALE);
    expect(isFar(FOCUS_MIN, [])).toBe(false);
  });

  it('keeps HQ in detailed mode on a 390×844 phone with the room sheet open, though the sheet leaves too little room to fit it', () => {
    expect(sheet).toEqual({ top: 100, right: 0, bottom: 473, left: 0 });
    const hq = focusRect(office, { kind: 'room', room: HQ_ID });
    expect(fitRect(hq, phone, sheet, 2.6).scale).toBeLessThan(FAR_SCALE);
    const fit = aimFor(office, { kind: 'room', room: HQ_ID }, phone, sheet);
    expect(fit.scale).toBeGreaterThanOrEqual(FAR_SCALE);
    expect(isFar(fit.scale, [])).toBe(false);
    expect(lodFor(fit.scale)).toBe(2);
    expect({ x: fit.x, y: fit.y }).toEqual({ x: hq.x + hq.w / 2, y: hq.y + hq.h / 2 });
  });

  it.each([
    ['320×568', { width: 320, height: 568 }], ['360×640', { width: 360, height: 640 }], ['390×844', { width: 390, height: 844 }],
    ['1280×800', { width: 1280, height: 800 }], ['700×300', { width: 700, height: 300 }],
  ] as const)('ends every room and actor focus in detailed mode on %s, sheet or dock open or not', (_name, view) => {
    const rooms = Object.keys(office.map.rooms);
    expect(rooms).toContain(HQ_ID);
    [stageInsets(view, false), stageInsets(view, true)].forEach((insets) => {
      rooms.forEach((room) => expect(isFar(aimFor(office, { kind: 'room', room }, view, insets).scale, [])).toBe(false));
      ['cedar:a', 'manager'].forEach((id) => expect(isFar(aimFor(office, { kind: 'actor', id }, view, insets).scale, [])).toBe(false));
    });
  });

  it('still fits a room whole wherever it fits at a detailed zoom', () => {
    const insets = stageInsets(phone, true);
    const fit = aimFor(office, { kind: 'room', room: 'cedar' }, phone, insets);
    expect(fit).toEqual(fitRect(focusRect(office, { kind: 'room', room: 'cedar' }), phone, insets, 2.6));
    expect(inside(roomRectPx(office.map.rooms.cedar!), fit, phone, insets)).toBe(true);
  });

  it('leaves a focus that fell back to the whole building at the fit of the building', () => {
    const fit = aimFor(office, { kind: 'room', room: 'nowhere' }, phone, sheet);
    expect(fit).toEqual(fitRect(office.map.zones.all, phone, sheet, 2.6));
    expect(fit.scale).toBeLessThan(FAR_SCALE);
  });
});

describe('clampCenter', () => {
  const building = { x: 16, y: 16, w: 1312, h: 640 };
  const view = { width: 1000, height: 600 };

  it('keeps the free area over the building plus the pan margin when zoomed in', () => {
    expect(PAN_MARGIN).toBe(64);
    expect(clampCenter({ x: -500, y: 9999 }, 2, view, NONE, building)).toEqual({ x: 16 - 64 + 250, y: 16 + 640 + 64 - 150 });
    expect(clampCenter({ x: 700, y: 300 }, 2, view, NONE, building)).toEqual({ x: 700, y: 300 });
  });

  it('centres an axis on which the free area is larger than the building, not under the panel', () => {
    const insets = { top: 0, right: 0, bottom: 300, left: 0 };
    const c = clampCenter({ x: 0, y: 0 }, 0.25, view, insets, building);
    const freeCentreY = c.y + (insets.top - insets.bottom) / 2 / 0.25;
    expect(freeCentreY).toBeCloseTo(336);
    expect(c.x).toBeCloseTo(672);
  });

  it('centres an axis even when the view is only a little larger than the building', () => {
    const scale = 1000 / 1350;
    expect(clampCenter({ x: 0, y: 336 }, scale, view, NONE, building).x).toBeCloseTo(672);
  });
});
