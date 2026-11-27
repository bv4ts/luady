// Must stay the first import: replaces PixiJS's `new Function` code generation with eval-free code, so the
// renderer works under the site's Content-Security-Policy (no 'unsafe-eval').
import 'pixi.js/unsafe-eval';
// The renderer starts with skipExtensionImports (see app.ts): only what the scene uses is registered, here. The event
// system is what pixi-viewport drags, pinches and wheels with; sprites, textures and the WebGL renderer come with the
// main entry. Accessibility, DOM containers and filters are never fetched.
import 'pixi.js/events';
import { Assets, TextureStyle } from 'pixi.js';

let prepared: Promise<void> | null = null;

/**
 * Gets PixiJS ready under the site's rules. Idempotent. Every scene module that touches Pixi is only reached
 * through code that awaited this first.
 * - nearest-neighbour scaling for every texture made afterwards (pixel art stays crisp);
 * - the asset loader without web workers (the CSP has no worker-src or blob:).
 */
export function preparePixi(): Promise<void> {
  prepared ??= (async () => {
    TextureStyle.defaultOptions.scaleMode = 'nearest';
    await Assets.init({ preferences: { preferWorkers: false } });
  })().catch((error: unknown) => {
    prepared = null;
    throw error;
  });
  return prepared;
}
