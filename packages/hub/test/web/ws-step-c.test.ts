import { describe, expect, it, vi } from 'vitest';
import { WsServerMessageSchema, type WsServerMessage } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { fanOut } from '../../src/web/ws.js';
import { ISO, sampleCard } from './helpers.js';

const MISSION = {
  sessionId: 'birch:cc-orchard:0.0', label: 'birch · orchard', title: 'Checkout', phase: 'working' as const, turns: 2, note: null, lastText: null,
  openedAt: ISO, idleSince: null,
};
const SAID = { sessionId: 'birch:cc-orchard:0.0', kind: 'reply' as const, text: 'Done.', truncated: false, at: ISO };

describe('fanOut for board, mission, session, notes, KB, library and Jira events', () => {
  it('forwards each of these bus events to every client as its WebSocket message', () => {
    const bus = createBus();
    const sent: WsServerMessage[] = [];
    const offs = fanOut(bus, (message) => sent.push(message));
    bus.emit('board.updated', { items: [sampleCard()] });
    bus.emit('board.removed', { ids: [12] });
    bus.emit('mission.updated', MISSION);
    bus.emit('mission.removed', { sessionId: MISSION.sessionId, outcome: 'done', summary: 'Shipped' });
    bus.emit('session.said', SAID);
    bus.emit('notes.changed', { at: ISO });
    bus.emit('kb.changed', { at: ISO });
    bus.emit('library.changed', { at: ISO });
    bus.emit('jira.changed', { room: 'birch', at: ISO });
    expect(sent).toEqual([
      { type: 'board.updated', items: [sampleCard()] },
      { type: 'board.removed', ids: [12] },
      { type: 'mission.updated', mission: MISSION },
      { type: 'mission.removed', sessionId: MISSION.sessionId, outcome: 'done', summary: 'Shipped' },
      { type: 'session.said', ...SAID },
      { type: 'notes.changed', at: ISO },
      { type: 'kb.changed', at: ISO },
      { type: 'library.changed', at: ISO },
      { type: 'jira.changed', room: 'birch', at: ISO },
    ]);
    for (const message of sent) expect(WsServerMessageSchema.parse(message)).toEqual(message);
    offs.forEach((off) => off());
  });

  it('stops forwarding once unsubscribed', () => {
    const bus = createBus();
    const broadcast = vi.fn();
    fanOut(bus, broadcast).forEach((off) => off());
    bus.emit('kb.changed', { at: ISO });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
