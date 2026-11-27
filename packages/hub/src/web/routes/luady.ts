import { LuadySendBodySchema, type LuadyMessageSentDTO } from '@luady/shared';
import { resolveAbout } from '../../luady/about.js';
import { ManagerOffError } from '../../luady/errors.js';
import type { RouteModule } from '../context.js';
import { listMemoryFiles, memoryRoot, readMemoryFile } from '../memory-files.js';
import { assertNotPinLike } from '../pin-guard.js';
import { MemoryFileQuerySchema, PageQuerySchema } from '../schemas.js';
import { parseBody, parseQuery } from '../validate.js';

/**
 * `GET /api/manager/switch`: the manager switch for the website's ManagerSwitch. `signIn` is true once
 * the bootstrap is done: only then is the manager's own Claude sign-in offered.
 */
export interface ManagerSwitchView {
  readonly enabled: boolean;
  readonly state: 'off' | 'starting' | 'on' | 'failed';
  readonly steps: ReadonlyArray<{ readonly id: string; readonly state: string; readonly detail: string | null }>;
  readonly signIn: boolean;
}

export const luadyRoutes: RouteModule = (app, ctx) => {
  const { luady, config, notices, presence, log, notes, board, jira } = ctx.deps;
  const manager = ctx.deps.manager;
  const root = memoryRoot(config.brainDir);
  app.get('/api/manager/messages', async (request) => {
    const query = parseQuery(PageQuerySchema, request.query);
    return luady.messages(query.cursor, query.limit);
  });
  app.post('/api/manager/messages', async (request): Promise<LuadyMessageSentDTO> => {
    const { text, about } = parseBody(LuadySendBodySchema, request.body);
    assertNotPinLike(text);
    // Off: 409 manager_off before anything is recorded.
    if (manager !== undefined && !manager.ready()) throw new ManagerOffError();
    // The note, card or ticket goes in front of what Luady receives; a missing one answers 404 first.
    const context = about === undefined ? undefined : await resolveAbout(about, { notes, board, jira });
    // Which kind of tab wrote decides whether Luady's answer can wait on the website (notices/router.ts). A failure
    // here only costs the website-first path for this answer; the owner's message always goes on.
    try {
      const sid = request.luadySession?.sid;
      notices.webMessage(sid !== undefined && presence.sessionSaidHello(sid));
    } catch (err) {
      log.error({ err }, 'notices: could not record a website message');
    }
    // Luady signed out: the message is kept for him (luady/service.ts); the page says so from this answer.
    const held = luady.signedOut?.() === true;
    if (context === undefined) await luady.postOwnerMessage(text, 'web');
    else await luady.postOwnerMessage(text, 'web', context);
    return held ? { ok: true, held: true } : { ok: true };
  });
  app.get('/api/manager/status', async () => luady.status());
  app.get('/api/manager/switch', async (): Promise<ManagerSwitchView> => {
    const state = manager?.state() ?? 'on';
    const steps = (manager?.bootstrap().steps ?? []).map((step) => ({ id: step.id, state: step.state, detail: step.detail }));
    return { enabled: ctx.deps.settings.get().manager_enabled, state, steps, signIn: state === 'on' };
  });
  app.get('/api/manager/memory', async () => ({ files: await listMemoryFiles(root) }));
  app.get('/api/manager/memory/file', async (request) => {
    const { name } = parseQuery(MemoryFileQuerySchema, request.query);
    return readMemoryFile(root, name);
  });
};
