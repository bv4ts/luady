import type { FastifyInstance, FastifyRequest } from 'fastify';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** HSTS for one year: sent only when publicOrigin is https and not localhost (config/remote.ts wantsHsts). */
export const HSTS_HEADER = 'strict-transport-security';

/** Every header, HSTS included: what an https, non-localhost origin gets. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000',
  'x-frame-options': 'DENY',
  // No other site's window keeps a handle on the hub's pages, and no other site may embed the hub's responses.
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
});

function isApiPathname(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** The router percent-decodes the path (`/%61pi/x` serves `/api/x`), so match the decoded form too. */
function decodedPathname(url: string): string | undefined {
  try {
    return decodeURIComponent(url.split('?', 1)[0] ?? '');
  } catch {
    return undefined;
  }
}

/** True for /api responses by the raw path, the decoded path or the matched route pattern. */
function isApiRequest(request: FastifyRequest): boolean {
  const raw = request.url.split('?', 1)[0] ?? '';
  const decoded = decodedPathname(request.url);
  const pattern = request.routeOptions.url;
  if (isApiPathname(raw)) return true;
  if (decoded !== undefined && isApiPathname(decoded)) return true;
  return pattern !== undefined && isApiPathname(pattern);
}

export interface SecurityHeaderOptions {
  /** False on http://localhost and https://localhost: HSTS there would pin every local port for a year. Default true. */
  readonly hsts?: boolean;
}

export function registerSecurityHeaders(app: FastifyInstance, options: SecurityHeaderOptions = {}): void {
  const headers = Object.entries(SECURITY_HEADERS).filter(([name]) => options.hsts !== false || name !== HSTS_HEADER);
  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of headers) {
      reply.header(name, value);
    }
    if (isApiRequest(request)) reply.header('cache-control', 'no-store');
    return payload;
  });
}
