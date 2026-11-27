import type { BoardItemDTO, NoteDTO, WsServerMessage } from '@luady/shared';
import { CARDS, EVENTS, MISSIONS, NOTES, TRANSCRIPT_PARTS } from './board-data.js';
import { iso } from './data.js';

/** The board, missions, delegation and notes routes of the pretend hub. Null = not one of these routes. */
export function createBoardRoutes(push: (message: WsServerMessage) => void) {
  let cards: readonly BoardItemDTO[] = CARDS;
  let notes: readonly NoteDTO[] = NOTES;
  let nextCard = 40;
  let nextNote = 10;
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const save = (card: BoardItemDTO): BoardItemDTO => {
    cards = [...cards.filter((c) => c.id !== card.id), card];
    return card;
  };

  const delegate = (body: Record<string, unknown>): Response => {
    const what = Array.isArray(body.what) ? (body.what as Array<{ kind: string; id?: number }>) : [];
    const ids = what.filter((w) => w.kind === 'todo').map((w) => w.id);
    const runId = `r_demo_${String(Date.now())}`;
    const items = cards.filter((c) => ids.includes(c.id)).map((c) => save({ ...c, state: 'queued', runId, updatedAt: iso(0) }));
    setTimeout(() => push({ type: 'board.updated', items }), 200);
    return json({ runId, items, manager: 'sent' });
  };

  return (method: string, path: string, url: URL, body: Record<string, unknown>): Response | null => {
    if (method === 'GET' && path === '/api/board') return json({ items: cards });
    if (method === 'POST' && path === '/api/manager/messages') return json({ ok: true });
    if (method === 'GET' && path === '/api/missions') return json({ items: MISSIONS });
    if (method === 'POST' && path === '/api/delegate') return delegate(body);
    if (method === 'POST' && path === '/api/board') {
      nextCard += 1;
      const card = save({ ...CARDS[CARDS.length - 1]!, id: nextCard, title: String(body.title ?? ''), details: String(body.details ?? ''),
        server: (body.server as BoardItemDTO['server']) ?? null, today: body.today === true, priority: body.priority === 1 ? 1 : 0,
        source: (body.source as BoardItemDTO['source']) ?? 'web', sourceRef: (body.sourceRef as string | undefined) ?? null,
        project: (body.project as string | undefined) ?? null, state: 'open', snoozeUntil: null, createdAt: iso(0), updatedAt: iso(0) });
      return json(card);
    }
    const one = /^\/api\/board\/(\d+)(\/delete)?$/.exec(path);
    if (one !== null) {
      const id = Number(one[1]);
      const found = cards.find((c) => c.id === id);
      if (found === undefined) return json({ error: { code: 'not_found', message: 'No such card' } }, 404);
      if (one[2] !== undefined) {
        cards = cards.filter((c) => c.id !== id);
        return json({ ok: true });
      }
      if (method === 'PUT') {
        const state = body.state === 'done' || body.state === 'open' ? body.state : found.state;
        return json(save({ ...found, ...body, state, doneAt: state === 'done' ? iso(0) : null, updatedAt: iso(0) } as BoardItemDTO));
      }
      return json({ item: found, events: EVENTS[id] ?? [], mission: MISSIONS.find((m) => m.sessionId === found.sessionId) ?? null });
    }
    if (method === 'GET' && path === '/api/notes') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase();
      return json({
        items: notes.filter((n) => q === '' || `${n.title} ${n.summary}`.toLowerCase().includes(q)),
        newCount: notes.filter((n) => n.isNew === true).length,
      });
    }
    if (method === 'POST' && path === '/api/notes') {
      nextNote += 1;
      const note: NoteDTO = { ...NOTES[0]!, id: `n:${String(nextNote)}`, title: String(body.title ?? '') || 'Untitled note', summary: String(body.body ?? ''),
        actionItems: null, project: (body.project as string | undefined) ?? null, at: iso(0) };
      notes = [note, ...notes];
      return json(note);
    }
    const note = /^\/api\/notes\/([^/]+)(\/transcript|\/delete|\/opened)?$/.exec(path);
    if (note !== null) {
      const id = decodeURIComponent(note[1] ?? '');
      const found = notes.find((n) => n.id === id);
      if (found === undefined) return json({ error: { code: 'not_found', message: 'No such note' } }, 404);
      if (note[2] === '/transcript') {
        const start = Number(url.searchParams.get('start') ?? '0');
        return json({ text: TRANSCRIPT_PARTS[start] ?? '', nextStart: start + 1 < TRANSCRIPT_PARTS.length ? start + 1 : null });
      }
      if (note[2] === '/opened') {
        if (found.isNew === true) {
          notes = notes.map((n) => (n.id === id ? { ...n, isNew: false } : n));
          push({ type: 'notes.changed', at: iso(0) });
        }
        return json({ ok: true });
      }
      if (note[2] === '/delete') {
        notes = notes.filter((n) => n.id !== id);
        return json({ ok: true });
      }
      if (method === 'PUT') {
        const next = { ...found, ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.body === 'string' ? { summary: body.body } : {}) };
        notes = notes.map((n) => (n.id === id ? next : n));
        return json(next);
      }
      return json(found);
    }
    return null;
  };
}
