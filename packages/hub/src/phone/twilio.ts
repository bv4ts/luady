import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** The Twilio number calls come from, E.164. */
  from: string;
}

const API = 'https://api.twilio.com/2010-04-01';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Twilio's request signature: base64(HMAC-SHA1(authToken, url + each POST param name+value, sorted by name)).
 * `url` must be the configured public URL Twilio called, never one rebuilt from request headers.
 */
export function twilioSignature(authToken: string, url: string, params: Readonly<Record<string, string>> = {}): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validTwilioSignature(
  authToken: string, header: string | undefined, url: string, params: Readonly<Record<string, string>> = {},
): boolean {
  if (header === undefined || header === '') return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface CreateCallArgs {
  to: string;
  /** Twilio fetches TwiML from here when the call is answered. */
  twimlUrl: string;
  statusUrl: string;
  /** Answering-machine detection result goes here (async AMD). */
  amdUrl: string;
}

export interface TwilioClient {
  createCall(args: CreateCallArgs): Promise<string>;
  hangUp(callSid: string): Promise<void>;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Minimal Calls API client (no SDK): place a call with async AMD, hang one up. */
export function createTwilioClient(creds: TwilioCredentials, fetchImpl: Fetch = fetch as unknown as Fetch): TwilioClient {
  const auth = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;

  async function post(path: string, form: Record<string, string>): Promise<unknown> {
    const response = await fetchImpl(`${API}/Accounts/${creds.accountSid}${path}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Twilio ${path} failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  return {
    async createCall(args) {
      const result = await post('/Calls.json', {
        To: args.to,
        From: creds.from,
        Url: args.twimlUrl,
        StatusCallback: args.statusUrl,
        StatusCallbackEvent: 'completed',
        MachineDetection: 'Enable',
        AsyncAmd: 'true',
        AsyncAmdStatusCallback: args.amdUrl,
        Timeout: '30',
      });
      const sid = (result as { sid?: unknown }).sid;
      if (typeof sid !== 'string') throw new Error('Twilio returned no call sid');
      return sid;
    },
    async hangUp(callSid) {
      await post(`/Calls/${encodeURIComponent(callSid)}.json`, { Status: 'completed' });
    },
  };
}
