/**
 * A tiny stand-in for the parts of pixi.js the scene uses. jsdom has no WebGL, so scene tests mock 'pixi.js' with
 * this module: `vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule)`.
 */
import { vi } from 'vitest';

export const RendererType = Object.freeze({ WEBGL: 1, WEBGPU: 2, CANVAS: 4 });

export class Rectangle {
  constructor(readonly x = 0, readonly y = 0, readonly width = 0, readonly height = 0) {}
}

export class TextureStyle {
  static defaultOptions: { scaleMode: string } = { scaleMode: 'linear' };
}

export class BufferImageSource {
  static created = 0;
  /** Width of every source made, in order (test helper). */
  static widths: number[] = [];
  readonly options: Record<string, unknown>;
  /** The pixels it uploads from; the chunk bank lets go of them once uploaded. */
  resource: unknown;
  destroyed = false;
  constructor(options: Record<string, unknown>) {
    BufferImageSource.created += 1;
    BufferImageSource.widths.push(Number(options.width));
    this.options = options;
    this.resource = options.resource;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** Stand-in for pixi's CanvasSource: counts its uploads. */
export class CanvasSource {
  readonly options: Record<string, unknown>;
  updates = 0;
  destroyed = false;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
  update(): void {
    this.updates += 1;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export class Texture {
  static readonly WHITE = new Texture({ label: 'WHITE' });
  static readonly EMPTY = new Texture({ label: 'EMPTY' });
  readonly source: unknown;
  readonly label: string;
  destroyed = false;
  readonly frame: unknown;
  constructor(options: { source?: unknown; label?: string; frame?: unknown } = {}) {
    this.source = options.source;
    this.label = options.label ?? '';
    this.frame = options.frame;
  }
  destroy(destroySource = false): void {
    this.destroyed = true;
    if (destroySource && (this.source instanceof BufferImageSource || this.source instanceof ImageSource || this.source instanceof CanvasSource)) {
      this.source.destroy();
    }
  }
}

/** Stand-in for pixi's ImageSource: keeps the options it was made with. */
export class ImageSource {
  readonly options: Record<string, unknown>;
  destroyed = false;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

/** Stand-in for pixi's Spritesheet: one Texture per frame name, made by parse(). */
export class Spritesheet {
  static instances: Spritesheet[] = [];
  readonly texture: Texture;
  readonly data: { frames: Record<string, unknown> };
  textures: Record<string, Texture> = {};
  destroyedBase: boolean | null = null;
  constructor(options: { texture: Texture; data: { frames: Record<string, unknown> } }) {
    this.texture = options.texture;
    this.data = options.data;
    Spritesheet.instances.push(this);
  }
  async parse(): Promise<Record<string, Texture>> {
    this.textures = Object.fromEntries(Object.keys(this.data.frames).map((name) => [name, new Texture({ source: this.texture.source, label: name })]));
    return this.textures;
  }
  destroy(destroyBase = false): void {
    this.destroyedBase = destroyBase;
    Object.values(this.textures).forEach((t) => t.destroy());
    if (destroyBase) this.texture.destroy(true);
  }
}

type Listener = (...args: unknown[]) => void;

/** A minimal event emitter, like pixi's (eventemitter3). */
export class Emitter {
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  off(event: string, fn?: Listener): this {
    this.listeners.set(event, fn === undefined ? [] : (this.listeners.get(event) ?? []).filter((f) => f !== fn));
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const list = this.listeners.get(event) ?? [];
    list.forEach((fn) => fn(...args));
    return list.length > 0;
  }
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
}

export class Container extends Emitter {
  children: Container[] = [];
  parent: Container | null = null;
  x = 0;
  y = 0;
  zIndex = 0;
  alpha = 1;
  visible = true;
  label = '';
  sortableChildren = false;
  eventMode = 'passive';
  destroyed = false;
  readonly scale = { x: 1, y: 1, set: (x: number, y = x): void => { this.scale.x = x; this.scale.y = y; } };
  readonly position = { set: (x: number, y = x): void => { this.x = x; this.y = y; } };
  addChild<T extends Container>(...items: T[]): T {
    items.forEach((item) => {
      item.parent?.removeChild(item);
      item.parent = this;
      this.children.push(item);
    });
    return items[0] as T;
  }
  addChildAt<T extends Container>(item: T, index: number): T {
    item.parent?.removeChild(item);
    item.parent = this;
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, item);
    return item;
  }
  removeChild<T extends Container>(...items: T[]): T {
    items.forEach((item) => {
      this.children = this.children.filter((c) => c !== item);
      item.parent = null;
    });
    return items[0] as T;
  }
  removeChildren(): Container[] {
    const gone = this.children;
    gone.forEach((c) => { c.parent = null; });
    this.children = [];
    return gone;
  }
  removeFromParent(): void {
    this.parent?.removeChild(this);
  }
  getChildIndex(child: Container): number {
    const at = this.children.indexOf(child);
    if (at < 0) throw new Error('getChildIndex: not a child');
    return at;
  }
  destroy(options?: { children?: boolean }): void {
    this.destroyed = true;
    this.removeFromParent();
    if (options?.children === true) [...this.children].forEach((c) => c.destroy(options));
  }
  /** Every descendant, depth first (test helper). */
  all(): Container[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

export class Sprite extends Container {
  texture: Texture;
  tint: number | string = 0xffffff;
  width = 0;
  height = 0;
  readonly anchor = { x: 0, y: 0, set: (x: number, y = x): void => { this.anchor.x = x; this.anchor.y = y; } };
  constructor(texture: Texture = Texture.EMPTY) {
    super();
    this.texture = texture;
  }
}

/** Stand-in for pixi's TilingSprite: a sprite that repeats its texture over width × height. */
export class TilingSprite extends Sprite {
  constructor(options: { texture?: Texture; width?: number; height?: number } = {}) {
    super(options.texture ?? Texture.EMPTY);
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
  }
}

export class Ticker {
  static readonly shared = new Ticker();
  readonly fns: Listener[] = [];
  started = true;
  deltaMS = 16;
  add(fn: Listener): this {
    this.fns.push(fn);
    return this;
  }
  remove(fn: Listener): this {
    const i = this.fns.indexOf(fn);
    if (i >= 0) this.fns.splice(i, 1);
    return this;
  }
  /** Runs every listener once (test helper). */
  tick(deltaMS = 16): void {
    this.deltaMS = deltaMS;
    [...this.fns].forEach((fn) => fn(this));
  }
}

interface Deferred { readonly promise: Promise<void>; resolve(): void; reject(error: unknown): void }
const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export class Application {
  static instances: Application[] = [];
  /** When true (the default), init resolves on its own; otherwise call resolveInit / rejectInit. */
  static autoResolve = true;
  static rendererType: number = RendererType.WEBGL;
  readonly canvas = document.createElement('canvas');
  readonly stage = new Container();
  readonly ticker = Ticker.shared;
  readonly screen = new Rectangle(0, 0, 800, 600);
  readonly renderer: Emitter & {
    type: number; resolution: number; width: number; height: number; events: { domElement: HTMLCanvasElement }; screen: Rectangle;
    resize: (width: number, height: number, resolution?: number) => void;
    texture: { initSource: (source: unknown) => void };
  } = Object.assign(new Emitter(), {
    type: Application.rendererType,
    resolution: 1,
    width: 800,
    height: 600,
    events: { domElement: this.canvas },
    screen: new Rectangle(0, 0, 800, 600),
    texture: { initSource: vi.fn() },
    resize: vi.fn((width: number, height: number, resolution?: number): void => {
      if (resolution !== undefined) this.renderer.resolution = resolution;
      this.renderer.emit('resize', width, height, this.renderer.resolution);
    }),
  });
  initOptions: Record<string, unknown> | null = null;
  private readonly gate = deferred();
  readonly init = vi.fn((options: Record<string, unknown>) => {
    this.initOptions = options;
    this.renderer.type = Application.rendererType;
    if (Application.autoResolve) this.gate.resolve();
    return this.gate.promise;
  });
  readonly destroy = vi.fn();
  readonly stop = vi.fn();
  readonly start = vi.fn();
  readonly queueResize = vi.fn();
  constructor() {
    Application.instances.push(this);
  }
  resolveInit(): void {
    this.gate.resolve();
  }
  rejectInit(error: unknown): void {
    this.gate.reject(error);
  }
}

export const Assets = { init: vi.fn(async () => undefined) };
export const isWebGLSupported = vi.fn(() => true);

/** Puts the fake back to its starting state between tests. */
export function resetFakePixi(): void {
  Application.instances = [];
  Application.autoResolve = true;
  Application.rendererType = RendererType.WEBGL;
  Spritesheet.instances = [];
  BufferImageSource.created = 0;
  BufferImageSource.widths = [];
  TextureStyle.defaultOptions = { scaleMode: 'linear' };
  Ticker.shared.fns.splice(0);
  Assets.init.mockClear();
  isWebGLSupported.mockReset();
  isWebGLSupported.mockReturnValue(true);
}

export const pixiModule = {
  Application, Assets, BufferImageSource, CanvasSource, Container, ImageSource, Rectangle, RendererType, Sprite, Spritesheet, Texture,
  TextureStyle, Ticker, TilingSprite, isWebGLSupported,
};
