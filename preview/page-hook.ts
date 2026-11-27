import type { FastifyInstance } from 'fastify';
import { ownerAt } from './seed-wave2.ts';

/**
 * The preview's hook into the website (preview only, never in the hub): every HTML page the preview serves loads
 * `/__preview/page.js` first, which marks the page as the demo (`globalThis.__LUADY_DEMO__`, which turns on the scene's
 * stats hook `window.__luadyStageStats()` in a production build), can fix the office's clock for day and night
 * (`globalThis.__LUADY_CLOCK__`, read by the scene's ambience layer) and, once, pretend the owner was away so the
 * welcome-back card shows on that load.
 */

export const PAGE_HOOK_PATH = '/__preview/page.js';
/** What the page keeps as "last here" (packages/web/src/features/agency/model/last-here.ts). */
export const LAST_HERE_KEY = 'hub.lastHere';
/** Where the website keeps the page key (packages/web/src/auth/page-key.ts). */
export const PAGE_KEY_STORAGE = 'hub.pageKey';
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MIN_MS = 60_000;

/** Named lights for `light`: full day, the middle of dusk, deep night, the middle of dawn. */
export const LIGHTS: Readonly<Record<string, string>> = { day: '12:00', dusk: '18:05', night: '22:30', dawn: '06:15' };

export interface PageHook {
  /** `HH:MM` owner time today, or null to follow the real clock. Returns the instant set (or null). */
  setClock(hhmm: string | null): Date | null;
  /** Fixes the office clock at an instant (`--clock <ISO>`), or null to follow the real clock. */
  setClockAt(at: Date | null): void;
  /** The next page load reads "last here" as `minutes` ago. */
  setAway(minutes: number): void;
  /** The page key of the preview's sign-in, stored by the next page load (once the hub issues page keys). */
  setPageKey(key: string): void;
  /** The script for one page load (an away is used up by it). */
  script(): string;
  state(): { readonly clockMs: number | null; readonly awayMinutes: number | null };
}

export function parseHhmm(text: string): { hh: number; mm: number } | null {
  const match = HHMM_RE.exec(text.trim());
  return match === null ? null : { hh: Number(match[1]), mm: Number(match[2]) };
}

/** The page script: plain ES5, no network, every part in a try so a refused storage never breaks the page. */
export function pageScript(clockMs: number | null, lastHereMs: number | null, pageKey: string | null = null, demo = false): string {
  const parts = [
    demo ? 'try { globalThis.__LUADY_DEMO__ = true; } catch (e) {}' : '',
    clockMs === null ? '' : `try { globalThis.__LUADY_CLOCK__ = ${String(clockMs)}; } catch (e) {}`,
    lastHereMs === null ? '' : `try { localStorage.setItem(${JSON.stringify(LAST_HERE_KEY)}, ${JSON.stringify(String(lastHereMs))}); } catch (e) {}`,
    pageKey === null ? '' : `try { localStorage.setItem(${JSON.stringify(PAGE_KEY_STORAGE)}, ${JSON.stringify(pageKey)}); } catch (e) {}`,
  ].filter((part) => part !== '');
  return `/* Luady preview: page hook */\n${parts.join('\n')}\n`;
}

/** The page loads the hook before its own scripts (a classic script in the head runs before module scripts). */
export function injectHook(html: string): string {
  const tag = `<script src="${PAGE_HOOK_PATH}"></script>`;
  if (html.includes(tag)) return html;
  const head = /<head[^>]*>/i.exec(html);
  return head === null ? `${tag}${html}` : html.replace(head[0], `${head[0]}${tag}`);
}

export function createPageHook(deps: { clock: () => Date }): PageHook {
  let clockMs: number | null = null;
  let awayMinutes: number | null = null;
  let pageKey: string | null = null;
  return {
    setClock(hhmm) {
      if (hhmm === null) {
        clockMs = null;
        return null;
      }
      const parsed = parseHhmm(hhmm);
      if (parsed === null) throw new Error('usage: clock <HH:MM> | clock off   (owner time, 24-hour, for example 19:30)');
      const at = ownerAt(deps.clock(), 0, parsed.hh, parsed.mm);
      clockMs = at.getTime();
      return at;
    },
    setClockAt(at) {
      clockMs = at === null ? null : at.getTime();
    },
    setPageKey(key) {
      pageKey = key;
    },
    setAway(minutes) {
      if (!Number.isFinite(minutes) || minutes < 31 || minutes > 7 * 24 * 60) throw new Error('usage: away <minutes 31..10080>');
      awayMinutes = minutes;
    },
    script() {
      const lastHere = awayMinutes === null ? null : deps.clock().getTime() - awayMinutes * MIN_MS;
      awayMinutes = null;
      const key = pageKey;
      pageKey = null;
      return pageScript(clockMs, lastHere, key, true);
    },
    state: () => ({ clockMs, awayMinutes }),
  };
}

async function textOf(payload: unknown): Promise<string | null> {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload !== null && typeof payload === 'object' && Symbol.asyncIterator in payload) {
    const chunks: Buffer[] = [];
    for await (const chunk of payload as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  return null;
}

/** The route and the HTML rewrite on the preview hub's own Fastify instance. */
export function registerPageHook(web: FastifyInstance, hook: PageHook): void {
  web.get(PAGE_HOOK_PATH, async (_request, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-store').send(hook.script()));
  web.addHook('onSend', async (request, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (request.method !== 'GET' || !type.startsWith('text/html')) return payload;
    const html = await textOf(payload);
    if (html === null) return payload;
    reply.removeHeader('content-length');
    reply.header('cache-control', 'no-store');
    return injectHook(html);
  });
}
