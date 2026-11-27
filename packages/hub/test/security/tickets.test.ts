import { describe, expect, it } from 'vitest';
import { createTicketStore, TICKET_TTL_MS } from '../../src/security/tickets.js';
import { createFakeClock } from '../../test/helpers/fakes.js';

/** Two website sessions: the one that asked for the ticket, and another one. */
const ASKER = 'sid-of-the-asking-session';
const OTHER = 'sid-of-another-session';

describe('createTicketStore', () => {
  it('issues 64-hex tickets that can be consumed once', () => {
    const store = createTicketStore(createFakeClock());
    const ticket = store.issue({ server: 'cedar', target: 'cc-meadow-hr:0.0', sid: ASKER });
    expect(ticket).toMatch(/^[a-f0-9]{64}$/);
    expect(store.consume(ticket, ASKER)).toEqual({ server: 'cedar', target: 'cc-meadow-hr:0.0' });
    expect(store.consume(ticket, ASKER)).toBeNull();
  });

  it('expires tickets after 60 seconds', () => {
    const clock = createFakeClock();
    const store = createTicketStore(clock);
    const early = store.issue({ server: 'birch', sid: ASKER });
    const late = store.issue({ server: 'birch', sid: ASKER });
    clock.advance(TICKET_TTL_MS - 1);
    expect(store.consume(early, ASKER)).toEqual({ server: 'birch' });
    clock.advance(1);
    expect(store.consume(late, ASKER)).toBeNull();
  });

  it('returns null for unknown or malformed tickets', () => {
    const store = createTicketStore(createFakeClock());
    store.issue({ server: 'ash', sid: ASKER });
    expect(store.consume('a'.repeat(64), ASKER)).toBeNull();
    expect(store.consume('not-a-ticket', ASKER)).toBeNull();
    expect(store.consume('', ASKER)).toBeNull();
  });

  it('is bound to the session that asked for it: another session gets nothing, and the ticket is spent', () => {
    const store = createTicketStore(createFakeClock());
    const ticket = store.issue({ server: 'cedar', sid: ASKER });
    expect(store.consume(ticket, OTHER)).toBeNull();
    expect(store.consume(ticket, '')).toBeNull();
    expect(store.consume(ticket, ASKER)).toBeNull();
  });

  it('refuses to issue a ticket bound to no session', () => {
    const store = createTicketStore(createFakeClock());
    expect(() => store.issue({ server: 'cedar', sid: '' })).toThrow();
  });

  it('keeps its own copy of the payload, without the session', () => {
    const store = createTicketStore(createFakeClock());
    const payload = Object.freeze({ server: 'cedar' as const, target: 'cc-x:0.0' });
    const consumed = store.consume(store.issue({ ...payload, sid: ASKER }), ASKER);
    expect(consumed).toEqual(payload);
    expect(consumed).not.toBe(payload);
  });

  it('never issues the same ticket twice', () => {
    const store = createTicketStore(createFakeClock());
    const tickets = new Set(Array.from({ length: 50 }, () => store.issue({ server: 'cedar', sid: ASKER })));
    expect(tickets.size).toBe(50);
  });
});
