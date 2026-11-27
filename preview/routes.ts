import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from '../packages/hub/dist/core/contracts.js';
import { createSessionWithPageKey } from '../packages/hub/dist/web/auth/sessions.js';
import type { PreviewFleet } from './fake-fleet.ts';
import { LOGIN_PATH, type LoginTokens } from './login-token.ts';

export interface PreviewRouteDeps {
  fleet: PreviewFleet;
  run: (scenario: string, args: readonly string[]) => Promise<string>;
  scenarios: readonly string[];
  /** The per-run sign-in token: the login route signs a browser in only with it, once. */
  login: LoginTokens;
  /** The page key of a sign-in, handed to the page through the page hook. */
  pageKey: (key: string) => void;
  log?: Logger;
}

const REFUSED_LOGIN = [
  '<!doctype html><meta charset="utf-8"><title>Luady preview</title>',
  '<p>This sign-in link was already used, or it is not from this run. Open the newest link the preview printed in its terminal.</p>',
].join('\n');

interface RunBody { readonly scenario: string; readonly args: readonly string[] }

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Readonly<Record<string, unknown>>)[key] : undefined;
}

function queryToken(query: unknown): string | undefined {
  const value = field(query, 't');
  return typeof value === 'string' ? value : undefined;
}

function parseRunBody(body: unknown): RunBody | string {
  const scenario = field(body, 'scenario');
  const args = field(body, 'args');
  if (typeof scenario !== 'string' || scenario === '') return 'Send JSON like { "scenario": "work", "args": ["cedar/meadow-vat"] }';
  if (args === undefined) return { scenario, args: [] };
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === 'string')) return '"args" must be a list of strings';
  return { scenario, args };
}

function refuse(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(400).send({ ok: false, error });
}

/** Preview-only routes on the hub's own Fastify instance; they exist only in this folder, never in the hub. */
export function registerPreviewRoutes(web: FastifyInstance, deps: PreviewRouteDeps): void {
  // The hub's own sign-in: a rotated session cookie and a page key, which the page hook hands to the next page.
  web.get(LOGIN_PATH, async (request, reply) => {
    if (!deps.login.take(queryToken(request.query))) {
      return reply.code(403).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(REFUSED_LOGIN);
    }
    const { pageKey } = createSessionWithPageKey(reply, 'preview', deps.log);
    deps.pageKey(pageKey);
    return reply.header('cache-control', 'no-store').redirect('/', 302);
  });

  web.get('/__preview/state', async () => ({
    hosts: Object.fromEntries(deps.fleet.kitHosts().map((host) => [host, deps.fleet.kit(host).panes()])),
    scenarios: deps.scenarios,
  }));

  web.post('/__preview/run', async (request, reply) => {
    const body = parseRunBody(request.body);
    if (typeof body === 'string') return refuse(reply, body);
    if (!deps.scenarios.includes(body.scenario)) {
      return refuse(reply, `unknown scenario "${body.scenario}". Known: ${deps.scenarios.join(', ')}`);
    }
    try {
      return { ok: true, result: await deps.run(body.scenario, body.args) };
    } catch (err) {
      return refuse(reply, err instanceof Error ? err.message : String(err));
    }
  });
}
