import WebSocket from 'ws';
import { PUBLIC_ORIGIN } from './fixtures.js';
import type { Harness, LoggedIn } from './helpers.js';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsProbe {
  ws: WebSocket;
  next(): Promise<WsMessage>;
  take(count: number): Promise<WsMessage[]>;
  /** Reads messages up to and including the first one of `type`. */
  until(type: string): Promise<WsMessage[]>;
  closed: Promise<{ code: number; reason: string }>;
}

export interface WsHeaderOptions {
  /** undefined = the harness token; null = no Access JWT. */
  token?: string | null;
  /** undefined = the public origin; null = no Origin header. */
  origin?: string | null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Listens on an ephemeral 127.0.0.1 port and returns the ws:// base URL. */
export async function listen(h: Harness): Promise<string> {
  const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
  return address.replace(/^http/, 'ws');
}

export function wsHeaders(h: Harness, session?: LoggedIn, opts: WsHeaderOptions = {}): Record<string, string> {
  const token = opts.token === undefined ? h.token : opts.token;
  const origin = opts.origin === undefined ? PUBLIC_ORIGIN : opts.origin;
  return {
    ...(token === null ? {} : { 'cf-access-jwt-assertion': token }),
    ...(origin === null ? {} : { origin }),
    ...(session === undefined ? {} : { cookie: session.cookie }),
  };
}

export function connectWs(url: string, headers: Record<string, string>): Promise<WsProbe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const inbox: WsMessage[] = [];
    const waiters: Array<(message: WsMessage) => void> = [];
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as WsMessage;
      const waiter = waiters.shift();
      if (waiter === undefined) inbox.push(message);
      else waiter(message);
    });
    const closed = new Promise<{ code: number; reason: string }>((done) => {
      ws.on('close', (code, reason) => done({ code, reason: reason.toString() }));
    });
    const next = (): Promise<WsMessage> => {
      const queued = inbox.shift();
      return queued === undefined ? new Promise((done) => waiters.push(done)) : Promise.resolve(queued);
    };
    const take = async (count: number): Promise<WsMessage[]> => {
      const out: WsMessage[] = [];
      while (out.length < count) out.push(await next());
      return out;
    };
    const until = async (type: string): Promise<WsMessage[]> => {
      const out: WsMessage[] = [];
      for (;;) {
        const message = await next();
        out.push(message);
        if (message.type === type) return out;
      }
    };
    ws.on('error', reject);
    ws.once('open', () => resolve({ ws, next, take, until, closed }));
  });
}

/** The HTTP status of a refused upgrade (ws reports "Unexpected server response: NNN"). */
export function rejectedStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      ws.close();
      reject(new Error('upgrade unexpectedly succeeded'));
    });
    ws.on('error', (err) => {
      const match = /Unexpected server response: (\d{3})/.exec(err.message);
      if (match?.[1] === undefined) reject(err);
      else resolve(Number(match[1]));
    });
  });
}
