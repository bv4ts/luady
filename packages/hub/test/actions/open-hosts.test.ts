import { describe, expect, it } from 'vitest';
import { createActionService } from '../../src/actions/service.js';
import { createBus } from '../../src/core/bus.js';
import type { ActionRequest, Fleet } from '../../src/core/contracts.js';
import { ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createHostLookups } from '../../src/fleet/host-lookups.js';
import { createTicketStore } from '../../src/security/tickets.js';
import { toolHostRefusal } from '../../src/tools/common.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';
import { createPausesStub, createPinStub, createSessionsStub, createChannelStub } from './stubs.js';

/** Open host ids: the params take any id; the service checks, when asked, that the fleet has the host. */
function setup() {
  const clock = createFakeClock();
  const lookups = createHostLookups(() => [
    { name: 'mars', projectsRoot: '/srv/mars' }, { name: 'computer', kind: 'local', projectsRoot: '/home/owner/projects' },
  ]);
  const fleet = { ...lookups, client: () => createFakeCtl(), servers: () => [] } as unknown as Fleet;
  return createActionService({
    db: openMemoryDb(), bus: createBus(), clock, log: silentLogger(), fleet, sessions: createSessionsStub(), pin: createPinStub(),
    channel: createChannelStub(), tickets: createTicketStore(clock), pauses: createPausesStub(),
  });
}

const ask = (kind: ActionRequest['kind'], params: Record<string, unknown>): ActionRequest => ({ kind, actor: 'manager', channel: 'event', params });

describe('actions on open host ids', () => {
  it('runs on a host no fixed list knew (mars), asks on this computer, and refuses a host the fleet does not have', async () => {
    const actions = setup();
    await expect(actions.request(ask('server.exec', { server: 'mars', command: 'ls' }))).resolves.toMatchObject({ status: 'done' });
    // Every command the manager runs on this computer waits for the PIN, even a read-only one.
    await expect(actions.request(ask('server.exec', { server: 'computer', command: 'ls' }))).resolves.toMatchObject({ status: 'pending_confirmation' });
    await expect(actions.request(ask('server.exec', { server: 'venus', command: 'ls' }))).rejects.toBeInstanceOf(ValidationError);
    await expect(actions.request(ask('server.exec', { server: 'hq', command: 'ls' }))).rejects.toBeInstanceOf(ValidationError);
    expect(actions.list({ limit: 10 }).map((action) => action.kind)).toEqual(['server.exec', 'server.exec']);
  });

  it('a terminal needs an SSH server; a sign-in any host the fleet has (the manager\'s own included) or codex', async () => {
    const actions = setup();
    await expect(actions.request(ask('terminal.open', { server: 'computer' }))).rejects.toThrow(/Unknown server/);
    await expect(actions.request(ask('account.logout', { target: 'venus' }))).rejects.toThrow(/Unknown host/);
    await expect(actions.request(ask('account.logout', { target: 'hq' }))).resolves.toMatchObject({ status: 'pending_confirmation' });
  });
});

describe('tool host arguments are checked when the tool runs', () => {
  const fleet = { ...createHostLookups(() => [{ name: 'mars' }, { name: 'computer', kind: 'local' }]) };

  it('a server or this computer for the server tools, never the manager\'s own host', () => {
    expect(toolHostRefusal('file_read', { server: 'mars' }, fleet)).toBeNull();
    expect(toolHostRefusal('file_read', { server: 'computer' }, fleet)).toBeNull();
    expect(toolHostRefusal('file_read', { server: 'hq' }, fleet)).toBe('unknown server: hq');
    expect(toolHostRefusal('file_upload', { server: 'venus' }, fleet)).toBe('unknown server: venus');
  });

  it('send_file may use the manager\'s workspace; the Jira tools name a room, which Jira checks itself', () => {
    expect(toolHostRefusal('send_file', { server: 'hq' }, fleet)).toBeNull();
    expect(toolHostRefusal('jira_get', { server: 'some-room' }, fleet)).toBeNull();
  });
});
