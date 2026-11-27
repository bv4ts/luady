import type { Application } from 'pixi.js';
import { crispResolution, type DensityChoice } from './pixel-density.js';

/** Phones run at 3 device pixels per CSS pixel; anything above that costs fill rate for no visible gain. */
export const MAX_DEVICE_RATIO = 3;

/** The device pixel ratio the scene draws for, capped at MAX_DEVICE_RATIO. */
export function deviceRatio(): number {
  const ratio = typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.min(ratio, MAX_DEVICE_RATIO);
}

/** Keeps the renderer's resolution matched to the zoom, so map pixels stay whole and even. */
export interface Density {
  /** Called when the view settled at `zoom`: picks the resolution and canvas scaling, and resizes the canvas if needed. */
  apply(zoom: number): DensityChoice;
}

export function createDensity(app: Application, ratio: () => number = deviceRatio): Density {
  return {
    apply: (zoom) => {
      const width = Math.round(app.screen.width);
      const height = Math.round(app.screen.height);
      const choice = crispResolution(zoom, ratio(), { width, height });
      if (Math.abs(choice.resolution - app.renderer.resolution) > 1e-6) app.renderer.resize(width, height, choice.resolution);
      app.canvas.style.imageRendering = choice.smooth ? 'auto' : 'pixelated';
      return choice;
    },
  };
}
