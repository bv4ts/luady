import { PAGE_KEY_HEADER } from '@luady/shared';
import { PAGE_HOOK_PATH, PAGE_KEY_STORAGE } from '../page-hook.ts';

/**
 * The preview's sign-in as the browser does it: this run's one-time link
 * (`/__preview/login?t=…`) sets the session cookie and hands the session's page key to the page hook, whose next script
 * stores it for the page. The tests read it from that same script, then send it on every `/api` call (`x-hub-key`) and
 * as a socket's first message.
 */
export interface PreviewSignIn {
  /** The `hub_sid=…` pair of the login's Set-Cookie. */
  readonly cookie: string;
  readonly pageKey: string;
}

const KEY_RE = new RegExp(`localStorage\\.setItem\\(${JSON.stringify(PAGE_KEY_STORAGE).replace(/\./g, '\\.')}, "([A-Za-z0-9_-]+)"\\)`);

/** The page key in the page hook's next script (it is there once, right after a sign-in). */
export async function pageKeyAfterLogin(url: string, cookie: string): Promise<string> {
  const script = await (await fetch(`${url}${PAGE_HOOK_PATH}`, { headers: { cookie } })).text();
  const key = KEY_RE.exec(script)?.[1];
  if (key === undefined) throw new Error('the preview login handed the page no page key');
  return key;
}

/** Signs in through the run's current one-time link, as the browser does; the link is used up. */
export async function signInPreview(preview: { readonly url: string; loginUrl(): string }): Promise<PreviewSignIn> {
  const res = await fetch(preview.loginUrl(), { redirect: 'manual' });
  if (res.status !== 302) throw new Error(`the preview login answered ${res.status}`);
  const sid = res.headers.getSetCookie().find((line) => line.startsWith('hub_sid='));
  if (sid === undefined) throw new Error('the preview login set no session cookie');
  const cookie = sid.split(';')[0] ?? '';
  return { cookie, pageKey: await pageKeyAfterLogin(preview.url, cookie) };
}

/** What a signed-in page sends on an `/api` call. */
export function signedIn(session: PreviewSignIn): Record<string, string> {
  return { cookie: session.cookie, [PAGE_KEY_HEADER]: session.pageKey };
}

/** A socket's first message: its page key; until then the hub sends it nothing. */
export function authFrame(pageKey: string): string {
  return JSON.stringify({ type: 'auth', key: pageKey });
}
