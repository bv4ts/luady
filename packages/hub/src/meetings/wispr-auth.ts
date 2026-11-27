import { createHash, randomBytes } from 'node:crypto';

/**
 * Wispr Flow OAuth (WorkOS AuthKit): dynamic client registration + authorization code with PKCE, refresh tokens via
 * offline_access. The device-code grant is advertised but Wispr denies activation for registered clients (2026-11-09),
 * so the owner approves in the browser and Wispr redirects to the hub's Access-protected callback.
 */
export const WISPR_MCP_URL = 'https://api.wisprflow.ai/connect/mcp';
export const WISPR_AUTH_BASE = 'https://mcp-auth.wisprflow.com/oauth2';
const SCOPE = 'openid offline_access';
const TIMEOUT_MS = 20_000;

export type FetchFn = typeof fetch;

export interface Tokens { accessToken: string; refreshToken: string | null; expiresInSec: number }
export interface Pkce { verifier: string; challenge: string }

/** The refresh token was rejected: the owner must sign in again. */
export class WisprSignedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WisprSignedOutError';
  }
}

async function post(fetchFn: FetchFn, path: string, body: URLSearchParams | object): Promise<{ status: number; data: Record<string, unknown> }> {
  const isForm = body instanceof URLSearchParams;
  const res = await fetchFn(`${WISPR_AUTH_BASE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' },
    body: isForm ? body.toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    data = { error: 'bad_response', error_description: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function describe(data: Record<string, unknown>, status: number): string {
  const error = str(data.error);
  const detail = str(data.error_description);
  return [error, detail].filter(Boolean).join(': ') || `HTTP ${status}`;
}

function toTokens(data: Record<string, unknown>): Tokens {
  const accessToken = str(data.access_token);
  if (accessToken === '') throw new Error('Wispr Flow returned no access token');
  return { accessToken, refreshToken: str(data.refresh_token) || null, expiresInSec: num(data.expires_in, 3600) };
}

export async function registerClient(fetchFn: FetchFn, redirectUri: string): Promise<string> {
  const { status, data } = await post(fetchFn, 'register', {
    client_name: 'Luady', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', redirect_uris: [redirectUri],
  });
  const clientId = str(data.client_id);
  if (status >= 300 || clientId === '') throw new Error(`Wispr Flow client registration failed: ${describe(data, status)}`);
  return clientId;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPE, state,
    code_challenge: challenge, code_challenge_method: 'S256', resource: WISPR_MCP_URL,
  });
  return `${WISPR_AUTH_BASE}/authorize?${params.toString()}`;
}

export async function exchangeCode(fetchFn: FetchFn, clientId: string, redirectUri: string, code: string, verifier: string): Promise<Tokens> {
  const { status, data } = await post(fetchFn, 'token', new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: WISPR_MCP_URL,
  }));
  if (status >= 300) throw new Error(`Wispr Flow refused the sign-in (${describe(data, status)})`);
  return toTokens(data);
}

export async function refreshTokens(fetchFn: FetchFn, clientId: string, refreshToken: string): Promise<Tokens> {
  const { status, data } = await post(fetchFn, 'token', new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: WISPR_MCP_URL,
  }));
  if (status < 300) return toTokens(data);
  const error = str(data.error);
  if (error === 'invalid_grant' || error === 'invalid_client' || error === 'unauthorized_client') {
    throw new WisprSignedOutError(`Wispr Flow sign-in is no longer valid: ${describe(data, status)}`);
  }
  throw new Error(`Wispr Flow token refresh failed: ${describe(data, status)}`);
}
