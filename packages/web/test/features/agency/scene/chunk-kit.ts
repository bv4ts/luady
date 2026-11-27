import { HQ_PALETTE, MUTE_PALETTE, type OfficeMap, type Palette, type PixelRect, type Raster } from '@luady/office';
import * as fake from './fake-pixi.js';

/**
 * Helpers for scene tests that draw chunks (import after mocking 'pixi.js' with fake-pixi): a GPU stand-in that keeps
 * what it was handed, a bank on a test clock, and views.
 */

/** The classic colours as palettes: rose, amber, jade and pv. */
export const P = {
  rose: { base: '#d6336c', accent: '#74b816' },
  amber: { base: '#f76707', accent: '#37b24d' },
  jade: { base: '#12b886', accent: '#c3fae8' },
  pv: { base: '#7c5cff', accent: '#ffd84d' },
  hq: HQ_PALETTE,
  mute: MUTE_PALETTE,
} as const satisfies Record<string, Palette>;

export interface Upload { readonly raster: Raster; readonly label: string; readonly texture: InstanceType<typeof fake.Texture> }

export const fakeGpu = () => {
  const uploads: Upload[] = [];
  return {
    uploads,
    upload: (raster: Raster, label: string) => {
      const texture = new fake.Texture({ label });
      uploads.push({ raster, label, texture });
      return texture as never;
    },
    destroy: (texture: unknown) => (texture as InstanceType<typeof fake.Texture>).destroy(true),
  };
};

/** The world rectangle a stage of `width × height` CSS pixels shows at `scale`, centred on `centre`. */
export const viewRect = (centre: { x: number; y: number }, scale: number, width: number, height: number): PixelRect =>
  ({ x: centre.x - width / 2 / scale, y: centre.y - height / 2 / scale, w: width / scale, h: height / scale });

/** The whole map and its garden, at zoom 1. */
export const wholeRect = (map: OfficeMap): PixelRect => ({ x: -320, y: -320, w: map.width + 640, h: map.height + 640 });
