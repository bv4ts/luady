import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fake from './fake-pixi.js';

vi.mock('pixi.js/unsafe-eval', () => ({}));
vi.mock('pixi.js/events', () => ({}));
vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const { createStageApp } = await import('../../../../src/features/agency/scene/app.js');
const { preparePixi } = await import('../../../../src/features/agency/scene/pixi-setup.js');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

let host: HTMLDivElement;

beforeEach(() => {
  fake.resetFakePixi();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

describe('preparePixi', () => {
  it('turns on nearest scaling and starts the asset loader without workers, once', async () => {
    await preparePixi();
    await preparePixi();
    expect(fake.TextureStyle.defaultOptions.scaleMode).toBe('nearest');
    expect(fake.Assets.init).toHaveBeenCalledTimes(1);
    expect(fake.Assets.init).toHaveBeenCalledWith({ preferences: { preferWorkers: false } });
  });
});

describe('createStageApp', () => {
  it('starts PixiJS with the crisp, CSP-safe WebGL options', async () => {
    vi.stubGlobal('devicePixelRatio', 4);
    const stage = await createStageApp(host);
    const options = fake.Application.instances[0]?.initOptions;
    expect(options).toMatchObject({
      preference: 'webgl',
      antialias: false,
      roundPixels: true,
      autoDensity: true,
      sharedTicker: true,
      resizeTo: host,
      skipExtensionImports: true,
    });
    expect(options?.resolution).toBe(3);
    expect(stage.app).toBe(fake.Application.instances[0]);
  });

  it('uses the device pixel ratio when it is 3 or less (sharp on phones)', async () => {
    vi.stubGlobal('devicePixelRatio', 1.5);
    await createStageApp(host);
    expect(fake.Application.instances[0]?.initOptions?.resolution).toBe(1.5);
    vi.stubGlobal('devicePixelRatio', 3);
    await createStageApp(host);
    expect(fake.Application.instances[1]?.initOptions?.resolution).toBe(3);
  });

  it('appends the canvas only after init resolved, drawn pixelated', async () => {
    fake.Application.autoResolve = false;
    const pending = createStageApp(host);
    await flush();
    const app = fake.Application.instances[0];
    expect(app).toBeDefined();
    expect(host.querySelector('canvas')).toBeNull();
    app?.resolveInit();
    await pending;
    expect(host.querySelector('canvas')).toBe(app?.canvas);
    expect(app?.canvas.style.imageRendering).toBe('pixelated');
  });

  it('destroys after init, once, keeping shared textures for a remount', async () => {
    const stage = await createStageApp(host);
    const app = fake.Application.instances[0];
    await stage.destroy();
    await stage.destroy();
    expect(app?.destroy).toHaveBeenCalledTimes(1);
    expect(app?.destroy).toHaveBeenCalledWith({ removeView: true, releaseGlobalResources: true }, { children: true });
  });

  it('turns a rejected init into webgl-unavailable and never appends a canvas', async () => {
    fake.Application.autoResolve = false;
    const pending = createStageApp(host);
    await flush();
    fake.Application.instances[0]?.rejectInit(new Error('WebGL context lost'));
    await expect(pending).rejects.toThrow('webgl-unavailable');
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('refuses to start when the browser has no WebGL', async () => {
    fake.isWebGLSupported.mockReturnValue(false);
    await expect(createStageApp(host)).rejects.toThrow('webgl-unavailable');
    expect(fake.Application.instances).toHaveLength(0);
  });

  it('refuses a fallback renderer (PixiJS would quietly pick WebGPU or canvas)', async () => {
    fake.Application.rendererType = fake.RendererType.CANVAS;
    await expect(createStageApp(host)).rejects.toThrow('webgl-unavailable');
    expect(fake.Application.instances[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('asks PixiJS to resize when the host element changes size, and stops watching on destroy', async () => {
    const observers: { cb: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      readonly disconnect = vi.fn();
      constructor(cb: () => void) {
        observers.push({ cb, disconnect: this.disconnect });
      }
      observe(): void {}
    });
    const stage = await createStageApp(host);
    observers[0]?.cb();
    expect(fake.Application.instances[0]?.queueResize).toHaveBeenCalledTimes(1);
    await stage.destroy();
    expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
  });
});
