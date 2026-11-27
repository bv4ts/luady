import { describe, expect, it, vi } from 'vitest';
import type { Application } from 'pixi.js';
import { createDensity } from '../../../../src/features/agency/scene/density.js';

/** A stand-in app whose renderer, like PixiJS's, reports a size a hair off after a resolution change. */
const fakeApp = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  const screen = { width, height };
  const renderer = {
    resolution: 1,
    resize: vi.fn((w: number, h: number, resolution?: number) => {
      if (resolution !== undefined) renderer.resolution = resolution;
      screen.width = Math.round(w * renderer.resolution) / renderer.resolution;
      screen.height = Math.round(h * renderer.resolution) / renderer.resolution;
    }),
  };
  return { app: { canvas, screen, renderer } as unknown as Application, renderer, canvas };
};

describe('createDensity', () => {
  it('raises the resolution for a fractional zoom and lets the browser scale the canvas smoothly', () => {
    const { app, renderer, canvas } = fakeApp(1920, 1080);
    const choice = createDensity(app, () => 1).apply(1920 / 1312);
    expect(choice.smooth).toBe(true);
    expect(renderer.resize).toHaveBeenCalledWith(1920, 1080, choice.resolution);
    expect(canvas.style.imageRendering).toBe('auto');
  });

  it('leaves the renderer alone when the resolution would not change', () => {
    const { app, renderer } = fakeApp(1920, 1080);
    const density = createDensity(app, () => 1);
    density.apply(1920 / 1312);
    density.apply(1920 / 1312);
    expect(renderer.resize).toHaveBeenCalledTimes(1);
  });

  it('asks for whole CSS pixels even after the renderer rounded the screen size', () => {
    const { app, renderer } = fakeApp(1366, 768);
    const density = createDensity(app, () => 1);
    density.apply(1.0125);
    density.apply(1.3);
    expect(renderer.resize.mock.calls.every(([w, h]) => Number.isInteger(w) && Number.isInteger(h))).toBe(true);
  });

  it('shows whole device pixels pixel for pixel', () => {
    const { app, canvas } = fakeApp(800, 600);
    createDensity(app, () => 2).apply(1.5);
    expect(canvas.style.imageRendering).toBe('pixelated');
  });
});
