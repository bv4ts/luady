import { isAbsolute, relative, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { isProtectedPath, pathOf } from './auth/chain.js';
import { errorBody } from './errors.js';

export const SPA_INDEX = 'index.html';

/** Vite puts a content hash in every file name under assets/, so a file there never changes. */
export const ASSETS_DIR = 'assets';
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** True for a file inside `<webDir>/assets/` (never index.html or other root files). */
export function isHashedAsset(webDir: string, filePath: string): boolean {
  const inside = relative(webDir, filePath);
  const parts = inside.split(sep);
  return !isAbsolute(inside) && parts.length > 1 && parts[0] === ASSETS_DIR;
}

/** Client-side routes: GET/HEAD outside /api and /ws get index.html instead of a 404. */
export function wantsSpaFallback(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !isProtectedPath(pathOf(url));
}

export async function registerStatic(app: FastifyInstance, webDir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    wildcard: true,
    index: [SPA_INDEX],
    dotfiles: 'ignore',
    redirect: false,
    setHeaders: (reply, filePath) => {
      if (isHashedAsset(webDir, filePath)) reply.header('cache-control', IMMUTABLE_CACHE);
    },
  });
  app.setNotFoundHandler((request, reply) => {
    if (wantsSpaFallback(request.method, request.url)) return reply.sendFile(SPA_INDEX);
    return reply.code(404).send(errorBody('not_found', 'Not found'));
  });
}
