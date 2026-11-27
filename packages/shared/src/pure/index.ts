/**
 * `@luady/shared/pure`: modules with no runtime imports outside this folder (only `import type`), so the office may
 * import them at run time (office/test/purity.test.ts).
 */
export * from './slots.js';
export * from './room-match.js';
export * from './colour.js';
export * from './owner-time.js';
export * from './display.js';
