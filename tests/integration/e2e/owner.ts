import { expect, type Page } from '@playwright/test';
import WebSocket from 'ws';

/** The owner in the browser: a virtual passkey, the first claim and PIN, and calls through the page's own session. */

export const OWNER_PIN = '246813';

/** A platform authenticator that says yes at once (Chrome DevTools Protocol); returns its id. */
export async function addVirtualAuthenticator(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}

/** The office, or without WebGL the classic Inbox. */
export async function expectOffice(page: Page): Promise<void> {
  await expect(page.getByTestId('agency-page').or(page.getByTestId('nav-inbox')).first()).toBeVisible();
}

/**
 * The setup wizard after the PIN: rooms kept as they are ("Next" with rooms, else "Skip for now"),
 * connect and extras skipped, then "Open the office".
 */
export async function finishWizard(page: Page): Promise<void> {
  const rooms = page.getByTestId('setup-rooms');
  await expect(rooms).toBeVisible();
  await rooms.getByTestId('rooms-step').getByRole('button', { name: /^(Next|Skip for now)$/ }).click();
  for (const step of ['setup-connect', 'setup-extras']) {
    const card = page.getByTestId(step);
    await expect(card).toBeVisible();
    await card.getByTestId('setup-skip').click();
  }
  await expect(page.getByTestId('setup-open')).toBeVisible();
  await page.getByTestId('setup-finish').click();
  await expectOffice(page);
}

/**
 * The first visit of an unclaimed hub: the setup code from the terminal and a passkey, then the PIN, then the rest of
 * the wizard skipped. Ends in the office (or, without WebGL, the classic Inbox).
 */
export async function claimOwner(page: Page, url: string, setupCode: string, pin: string = OWNER_PIN): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('setup-claim')).toBeVisible();
  await page.getByTestId('setup-code-input').fill(setupCode);
  await page.getByTestId('setup-passkey-button').click();
  await expect(page.getByTestId('setup-pin')).toBeVisible();
  await page.getByTestId('pin-new-input').fill(pin);
  await page.getByTestId('pin-confirm-input').fill(pin);
  await page.getByTestId('pin-save-button').click();
  await finishWizard(page);
}

export interface PageAnswer { readonly status: number; readonly body: unknown }

/** The PIN prompt the website shows before a change that needs it: the PIN, then Enter. */
export async function answerPin(page: Page, pin: string = OWNER_PIN): Promise<void> {
  const field = page.getByLabel('PIN', { exact: true });
  await field.fill(pin);
  await field.press('Enter');
}

/**
 * An `/api` call made by the page itself: its cookie, the page key it keeps, and the CSRF token for a change; `extra`
 * adds headers (a host's grant).
 */
export async function pageApi(page: Page, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<PageAnswer> {
  return page.evaluate(async ({ method: verb, path: target, body: payload, extra: more }) => {
    const key = localStorage.getItem('hub.pageKey');
    const keyed: Record<string, string> = key === null ? {} : { 'x-hub-key': key };
    const me = (await (await fetch('/api/me', { headers: keyed })).json()) as { csrf?: string };
    const base: Record<string, string> = verb === 'GET' ? keyed : { ...keyed, 'content-type': 'application/json', 'x-hub-csrf': me.csrf ?? '' };
    const headers = { ...base, ...more };
    const res = await fetch(target, { method: verb, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON: the text itself
    }
    return { status: res.status, body: parsed };
  }, { method, path, body, extra });
}

/**
 * The in-process test hub's public origin is https://localhost:<port> but it listens on plain HTTP: the browser visits
 * https://localhost:<port> and every request is forwarded to http://localhost:<port>, so the Host stays the one the hub
 * answers to (its Host check refuses any other with 421). WebAuthn treats https://localhost as a secure origin with RP
 * ID "localhost".
 */
export async function routeHttpsToHub(page: Page, port: number): Promise<void> {
  await page.route(`https://localhost:${port}/**`, async (route) => {
    const target = route.request().url().replace('https://localhost:', 'http://localhost:');
    const response = await route.fetch({ url: target, headers: await route.request().allHeaders() });
    await route.fulfill({ response });
  });
  await page.routeWebSocket(`wss://localhost:${port}/**`, async (ws) => {
    const url = new URL(ws.url());
    const cookie = (await page.context().cookies(`https://localhost:${port}`)).map((c) => `${c.name}=${c.value}`).join('; ');
    const upstream = new WebSocket(`ws://localhost:${port}${url.pathname}${url.search}`, {
      headers: { cookie, origin: `https://localhost:${port}` },
    });
    const queue: Array<string | Buffer> = [];
    ws.onMessage((message: string | Buffer) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      else queue.push(message);
    });
    upstream.on('open', () => queue.splice(0).forEach((message) => upstream.send(message)));
    upstream.on('message', (data, isBinary) => ws.send(isBinary ? (data as Buffer) : data.toString('utf8')));
    upstream.on('close', (code, reason) => ws.close({ code: code === 1005 ? 1000 : code, reason: reason.toString() }));
    upstream.on('error', () => ws.close({ code: 1011 }));
    ws.onClose(() => upstream.close());
  });
}
