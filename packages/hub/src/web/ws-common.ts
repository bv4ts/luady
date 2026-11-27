import type { RawData, WebSocket } from 'ws';
import type { z } from 'zod';

export function rawToText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses one client frame with the given zod schema; null for invalid JSON or schema failures. */
export function parseJsonMessage<T extends z.ZodType>(raw: RawData, schema: T): z.infer<T> | null {
  const value = decodeJson(rawToText(raw));
  if (value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function sendText(socket: WebSocket, text: string): void {
  if (socket.readyState === socket.OPEN) socket.send(text);
}

export function sendJson(socket: WebSocket, message: unknown): void {
  sendText(socket, JSON.stringify(message));
}

/**
 * Asks whether a session still lives, for a check that runs on a timer. Such a check must never throw: once the hub is
 * stopping the database is closed, and an error inside a timer would end the whole process. A failed check counts as
 * "the session has ended".
 */
export function sessionStillLive(peek: () => unknown): boolean {
  try {
    return peek() !== null;
  } catch {
    return false;
  }
}
