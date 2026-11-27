// Browser helpers for the docs pictures: Playwright from tests/integration, pages with a fixed zone and locale,
// the https route a passkey needs, a virtual passkey, and the waits before a picture.
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * The time zone and language every picture is taken in, whatever this machine uses: the demo owner's own fixed zone
 * (PREVIEW_OWNER_TZ in preview/config.ts), so a page that shows the browser's zone names only that one.
 */
export const BROWSER_ZONE = 'Etc/GMT-4';
export const BROWSER_LOCALE = 'en-US';

/** Loads Playwright (and ws) from tests/integration, the folder that pins the version the browser tests use. */
export function loadTestModules(repoRoot) {
  const require = createRequire(join(repoRoot, 'tests', 'integration', 'package.json'));
  try {
    return { playwright: require('playwright'), WebSocket: require('ws') };
  } catch {
    throw new Error('Playwright is not installed. Run: npm --prefix tests/integration ci   then: npm --prefix tests/integration exec -- playwright install chromium');
  }
}

/** A free TCP port on this machine. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** The office clock as the top bar writes it: "6:07 PM" in the zone, a plain space before AM or PM (hud/Clock.tsx). */
export function clockLabel(at, zone) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone }).format(at).replace(/\s/g, ' ');
}

/**
 * Keeps the top bar's clock (time.agency-clock) at the office clock's label: the page writes the real time there, and
 * the page's own Date cannot be moved (see newPage). Runs before the page's scripts and rewrites the label whenever the
 * page changes it; only the words on screen change.
 */
function holdClockLabel(label) {
  const hold = () => document.querySelectorAll('time.agency-clock').forEach((node) => {
    if (node.textContent !== label) node.textContent = label;
  });
  new MutationObserver(hold).observe(document, { subtree: true, childList: true, characterData: true });
}

/**
 * A new page in its own context: the viewport in CSS pixels, the device scale, a phone when asked, and the fixed zone
 * and language. The page's own Date is left alone: the notices and the usage bar compare it with the hub's times, so a
 * page in another time would show old notices again and hide the usage bar. `clock`: the label the top bar's clock
 * shows instead of the real time. `zone`: the browser's time zone (default BROWSER_ZONE).
 */
export async function newPage(browser, { width, height, scale = 1, phone = false, storageState, clock, zone = BROWSER_ZONE } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, isMobile: phone, hasTouch: phone,
    locale: BROWSER_LOCALE, timezoneId: zone, reducedMotion: 'no-preference', colorScheme: 'dark',
    ignoreHTTPSErrors: true, ...(storageState === undefined ? {} : { storageState }),
  });
  if (clock !== undefined) await context.addInitScript(holdClockLabel, clock);
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`  page error: ${error.message}`));
  return { context, page };
}

/**
 * The demo listens on plain http, but a passkey needs the hub's https origin. The page visits https://localhost:<port>
 * and every request and socket is passed on to http://localhost:<port> (as the browser tests do).
 */
export async function routeHttpsToHub(page, port, WebSocket) {
  await page.route(`https://localhost:${port}/**`, async (route) => {
    const target = route.request().url().replace('https://localhost:', 'http://localhost:');
    const response = await route.fetch({ url: target, headers: await route.request().allHeaders() });
    await route.fulfill({ response });
  });
  await page.routeWebSocket(`wss://localhost:${port}/**`, async (ws) => {
    const url = new URL(ws.url());
    const cookie = (await page.context().cookies(`https://localhost:${port}`)).map((c) => `${c.name}=${c.value}`).join('; ');
    const upstream = new WebSocket(`ws://localhost:${port}${url.pathname}${url.search}`, { headers: { cookie, origin: `https://localhost:${port}` } });
    const queue = [];
    ws.onMessage((message) => (upstream.readyState === WebSocket.OPEN ? upstream.send(message) : queue.push(message)));
    upstream.on('open', () => queue.splice(0).forEach((message) => upstream.send(message)));
    upstream.on('message', (data, isBinary) => ws.send(isBinary ? data : data.toString('utf8')));
    upstream.on('close', (code, reason) => ws.close({ code: code === 1005 ? 1000 : code, reason: reason.toString() }));
    upstream.on('error', () => ws.close({ code: 1011 }));
    ws.onClose(() => upstream.close());
  });
}

/** A passkey authenticator in the browser that says yes at once (Chrome DevTools Protocol). */
export async function addVirtualPasskey(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/**
 * A part of the screen, exactly `width` x `height` picture pixels, its top left corner at the CSS point (x, y) of a
 * page drawn at `scale`. The whole screen is taken and the part is copied out pixel for pixel (in a blank page's canvas,
 * no scaling), because a screenshot clip at a fractional scale can come out a pixel short.
 */
export async function areaShot(page, x, y, width, height, scale) {
  const screen = await page.screenshot();
  const left = Math.round(x * scale);
  const top = Math.round(y * scale);
  const blank = await page.context().browser().newPage();
  try {
    const url = await blank.evaluate(async ({ src, area }) => {
      const picture = new Image();
      picture.src = src;
      await picture.decode();
      if (area.left < 0 || area.top < 0 || area.left + area.width > picture.width || area.top + area.height > picture.height) {
        throw new Error(`the area ${JSON.stringify(area)} is not inside the ${picture.width}x${picture.height} screen`);
      }
      const canvas = document.createElement('canvas');
      Object.assign(canvas, { width: area.width, height: area.height });
      canvas.getContext('2d').drawImage(picture, area.left, area.top, area.width, area.height, 0, 0, area.width, area.height);
      return canvas.toDataURL('image/png');
    }, { src: `data:image/png;base64,${screen.toString('base64')}`, area: { left, top, width, height } });
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  } finally {
    await blank.close();
  }
}

/**
 * Waits until the hub's newest notice is older than the office's toast window, so a page loaded now lists the demo's
 * notices instead of popping them up as toasts (the office toasts what arrives from 10 s before it loaded).
 */
export async function noticesSettled(page, quietMs = 15_000) {
  for (let tries = 0; tries < 40; tries += 1) {
    const { items } = await pageApi(page, 'GET', '/api/notices?limit=50');
    const newest = Math.max(0, ...items.map((notice) => Date.parse(notice.createdAt)));
    const age = Date.now() - newest;
    if (age >= quietMs) return;
    await page.waitForTimeout(Math.min(quietMs - age + 500, 5_000));
  }
  throw new Error('the demo keeps making notices');
}

/** Waits until the office's paint queue is empty, then two more frames. */
export async function officeSettled(page) {
  await page.waitForFunction(() => globalThis.__luadyStageStats?.().pending === 0, undefined, { timeout: 90_000, polling: 100 });
  await nextFrames(page, 2);
  await page.waitForFunction(() => globalThis.__luadyStageStats?.().pending === 0, undefined, { timeout: 90_000, polling: 100 });
}

/**
 * Waits for the page's fonts, for its CSS animations and transitions to end (a dialog fades in: taken too early, the
 * page shows through it; endless ones such as a spinner are not waited for), and a few painted frames.
 */
export async function pageSettled(page, frames = 3) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'
    || animation.effect?.getComputedTiming().iterations === Infinity), undefined, { timeout: 15_000, polling: 50 })
    .catch(() => console.warn('  an animation on the page kept running for 15 s; taking the picture anyway'));
  await nextFrames(page, frames);
}

export function nextFrames(page, count) {
  return page.evaluate((n) => new Promise((done) => {
    let left = n;
    const tick = () => (left-- <= 0 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), count);
}

/** An /api call made by the page itself, with its page key and CSRF token (as the website makes it). */
export function pageApi(page, method, path, body) {
  return page.evaluate(async ({ verb, target, payload }) => {
    const key = localStorage.getItem('hub.pageKey');
    const keyed = key === null ? {} : { 'x-hub-key': key };
    const me = await (await fetch('/api/me', { headers: keyed })).json();
    const headers = verb === 'GET' ? keyed : { ...keyed, 'content-type': 'application/json', 'x-hub-csrf': me.csrf ?? '' };
    const res = await fetch(target, { method: verb, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: keep the text
    }
    if (!res.ok) throw new Error(`${verb} ${target}: ${res.status} ${text.slice(0, 200)}`);
    return parsed;
  }, { verb: method, target: path, payload: body });
}
