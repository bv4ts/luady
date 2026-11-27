/** Stand-in for pixi-viewport: `vi.mock('pixi-viewport', async () => await import('./fake-viewport.js'))`. */
import { Container } from './fake-pixi.js';

interface Options { screenWidth: number; screenHeight: number; worldWidth: number; worldHeight: number }

export class Viewport extends Container {
  static instances: Viewport[] = [];
  readonly options: Options;
  screenWidth: number;
  screenHeight: number;
  readonly center = { x: 0, y: 0 };
  readonly animations: Record<string, unknown>[] = [];
  readonly plugins = { get: (): null => null, remove: (): void => undefined };

  constructor(options: Options) {
    super();
    this.options = options;
    this.screenWidth = options.screenWidth;
    this.screenHeight = options.screenHeight;
    Viewport.instances.push(this);
  }

  drag(): this { return this; }
  pinch(): this { return this; }
  wheel(): this { return this; }
  decelerate(): this { return this; }
  clampZoom(): this { return this; }

  moveCenter(x: number, y: number): this {
    this.center.x = x;
    this.center.y = y;
    this.x = this.screenWidth / 2 - x * this.scale.x;
    this.y = this.screenHeight / 2 - y * this.scale.y;
    return this;
  }

  /** Jumps straight to the end of the glide. */
  animate(options: { position: { x: number; y: number }; scale: number; callbackOnComplete?: (vp: Viewport) => void }): this {
    this.animations.push(options);
    this.scale.set(options.scale);
    this.moveCenter(options.position.x, options.position.y);
    options.callbackOnComplete?.(this);
    return this;
  }

  resize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.center.x) * this.scale.x + this.screenWidth / 2, y: (y - this.center.y) * this.scale.y + this.screenHeight / 2 };
  }

  toWorld(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.screenWidth / 2) / this.scale.x + this.center.x, y: (y - this.screenHeight / 2) / this.scale.y + this.center.y };
  }
}
