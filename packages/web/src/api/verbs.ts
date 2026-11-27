import type { z } from 'zod';
import { ApiError } from './errors.js';
import type { Http } from './http.js';

/** Extra headers of one request (a host grant, say). */
export type RequestHeaders = Readonly<Record<string, string>>;

/** The three methods every route module builds on; responses are validated with the given schema. */
export interface Verbs {
  readonly get: <S extends z.ZodType>(path: string, schema: S, headers?: RequestHeaders) => Promise<z.output<S>>;
  readonly post: <S extends z.ZodType>(path: string, schema: S, body: unknown, headers?: RequestHeaders) => Promise<z.output<S>>;
  readonly put: <S extends z.ZodType>(path: string, schema: S, body: unknown, headers?: RequestHeaders) => Promise<z.output<S>>;
}

export function verbsFor(http: Http): Verbs {
  return {
    get: <S extends z.ZodType>(path: string, schema: S, headers?: RequestHeaders) => http.request('GET', path, schema, undefined, headers),
    post: <S extends z.ZodType>(path: string, schema: S, body: unknown, headers?: RequestHeaders) => http.request('POST', path, schema, body, headers),
    put: <S extends z.ZodType>(path: string, schema: S, body: unknown, headers?: RequestHeaders) => http.request('PUT', path, schema, body, headers),
  };
}

/** Validates an outgoing body with its schema so UI bugs never reach the hub. */
export function checked<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
  throw new ApiError(0, 'invalid_request', `${where}${issue?.message ?? 'Invalid request'}`);
}

export const seg = (value: string): string => encodeURIComponent(value);

export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const EMPTY = {};
