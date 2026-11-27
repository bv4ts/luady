import { GRASS } from '@luady/office';
import { Application, RendererType, isWebGLSupported } from 'pixi.js';
import { deviceRatio } from './density.js';
import { preparePixi } from './pixi-setup.js';

export interface StageApp {
  readonly app: Application;
  /** Stops watching the host and destroys the app. Safe to call twice. */
  readonly destroy: () => Promise<void>;
}

/** The reason given when this browser cannot run the scene; the page falls back to the classic view. */
export const WEBGL_UNAVAILABLE = 'webgl-unavailable';

/** Background behind the map: the grass colour, so nothing flashes before the ground is drawn. */
const BACKGROUND = GRASS.base;

/** Makes the canvas fill its host, crisp (density.ts switches to smooth scaling when it draws larger), no callout. */
const styleCanvas = (canvas: HTMLCanvasElement): void => {
  canvas.style.display = 'block';
  canvas.style.imageRendering = 'pixelated';
  canvas.style.userSelect = 'none';
  canvas.style.setProperty('-webkit-touch-callout', 'none');
  canvas.style.setProperty('-webkit-user-select', 'none');
};

const quietDestroy = (app: Application): void => {
  try {
    app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
  } catch (error) {
    console.warn('[agency] could not tear down a half-started PixiJS app', error);
  }
};

/** Resizes the renderer whenever the host changes size (resizeTo alone only follows the window). */
const watchSize = (host: HTMLElement, app: Application): (() => void) => {
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(() => app.queueResize());
  observer.observe(host);
  return () => observer.disconnect();
};

/**
 * Starts a WebGL PixiJS app inside `host`. The canvas is appended only once init has resolved.
 * Throws Error('webgl-unavailable') when the browser has no WebGL or init fails.
 */
export async function createStageApp(host: HTMLElement): Promise<StageApp> {
  await preparePixi();
  if (!isWebGLSupported()) throw new Error(WEBGL_UNAVAILABLE);
  const app = new Application();
  try {
    await app.init({
      preference: 'webgl',
      antialias: false,
      roundPixels: true,
      autoDensity: true,
      resolution: deviceRatio(),
      sharedTicker: true,
      resizeTo: host,
      background: BACKGROUND,
      // Do not fetch PixiJS's browser bundle (accessibility, DOM, filters); pixi-setup.ts imports what the scene needs.
      skipExtensionImports: true,
    });
  } catch (error) {
    console.error('[agency] PixiJS could not start', error);
    throw new Error(WEBGL_UNAVAILABLE, { cause: error });
  }
  // preference only orders the choices: without WebGL PixiJS would fall back to WebGPU or canvas.
  if (app.renderer.type !== RendererType.WEBGL) {
    quietDestroy(app);
    throw new Error(WEBGL_UNAVAILABLE);
  }
  styleCanvas(app.canvas);
  host.appendChild(app.canvas);
  const unwatch = watchSize(host, app);
  let destroyed = false;
  return {
    app,
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      unwatch();
      app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    },
  };
}
