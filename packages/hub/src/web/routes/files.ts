import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { ChannelsService } from '../../core/contracts.js';
import { OUTBOX_ID_RE, safeFileName } from '../../channels/outbox.js';
import type { RouteModule } from '../context.js';
import { errorBody } from '../errors.js';
import { parseParams } from '../validate.js';

const FileParamsSchema = z.strictObject({ id: z.string().regex(OUTBOX_ID_RE) });

/** An ASCII fallback name plus the exact UTF-8 one (RFC 6266 / 5987). */
export function attachmentHeader(name: string): string {
  const safe = safeFileName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/**
 * `GET /api/files/:id`: a file the hub kept for the owner while no chat channel was up. Behind the
 * session and the page key like every /api route; always a download, never rendered: `attachment`, `nosniff`, and a
 * sandboxing CSP in case a browser opens it anyway.
 */
export function registerFileRoutes(app: Parameters<RouteModule>[0], channels: Pick<ChannelsService, 'file'>): void {
  app.get('/api/files/:id', {
    // After the global security headers: a stricter policy for a file a browser should never render.
    onSend: async (_request, reply, payload) => {
      reply.header('content-security-policy', "sandbox; default-src 'none'");
      return payload;
    },
  }, async (request, reply) => {
    const { id } = parseParams(FileParamsSchema, request.params);
    const found = channels.file(id);
    if (found === null) return reply.code(404).send(errorBody('not_found', 'No such file (files are kept for 30 days)'));
    return reply
      .header('content-type', found.file.mime)
      .header('content-length', String(found.file.size))
      .header('content-disposition', attachmentHeader(found.file.name))
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(found.path));
  });
}
