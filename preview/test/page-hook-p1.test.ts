import { describe, expect, it } from 'vitest';
import { PAGE_KEY_STORAGE, createPageHook } from '../page-hook.ts';

const NOW = new Date('2026-11-21T08:00:00.000Z');

describe('the page hook carries the page key and a fixed clock', () => {
  it('stores the sign-in page key on the next page load only', () => {
    const hook = createPageHook({ clock: () => NOW });
    expect(hook.script()).not.toContain(PAGE_KEY_STORAGE);
    hook.setPageKey('k'.repeat(43));
    expect(hook.script()).toContain(`localStorage.setItem("${PAGE_KEY_STORAGE}", "${'k'.repeat(43)}")`);
    expect(hook.script()).not.toContain(PAGE_KEY_STORAGE);
  });

  it('marks every page as the demo, so the scene installs its stats hook in a production build', () => {
    const hook = createPageHook({ clock: () => NOW });
    for (let load = 0; load < 2; load += 1) expect(hook.script()).toContain('globalThis.__LUADY_DEMO__ = true;');
  });

  it('--clock fixes the office clock at that instant, and null follows the real clock again', () => {
    const hook = createPageHook({ clock: () => NOW });
    hook.setClockAt(new Date('2026-11-21T12:00:00Z'));
    expect(hook.state().clockMs).toBe(Date.parse('2026-11-21T12:00:00Z'));
    expect(hook.script()).toContain(`__LUADY_CLOCK__ = ${Date.parse('2026-11-21T12:00:00Z')}`);
    hook.setClockAt(null);
    expect(hook.state().clockMs).toBeNull();
  });
});
