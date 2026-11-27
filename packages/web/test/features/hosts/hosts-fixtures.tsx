import type { HostDTO, HostJobDTO } from '@luady/shared';
import { screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi, type Mock } from 'vitest';
import type { HostsApi } from '../../../src/api/hosts.js';
import { HostsApiProvider } from '../../../src/features/hosts/context.js';
import type { PageHarness } from '../../helpers/render.js';
import { hostDto } from '../../room-fixtures.js';

export const PIN = '123456';
/** An ed25519 key line built from parts (the type string and 32 key bytes): no scanner sees a real key. */
export const BLOB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 9)]).toString('base64');
export const KEY_LINE = `no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${BLOB} luady-fleet`;
export const FP = `SHA256:${'F'.repeat(42)}0`;

export type FakeHostsApi = { [K in keyof HostsApi]: Mock<HostsApi[K]> } & { hosts: HostDTO[] };

/** A hosts API over an in-memory list; each method can be replaced per test. */
export function fakeHostsApi(initial: HostDTO[] = []): FakeHostsApi {
  const hosts: HostDTO[] = [...initial];
  const put = (host: HostDTO): HostDTO => {
    const at = hosts.findIndex((one) => one.id === host.id);
    if (at === -1) hosts.push(host);
    else hosts.splice(at, 1, host);
    return host;
  };
  const find = (id: string): HostDTO => hosts.find((one) => one.id === id) ?? hostDto({ id });
  const job: HostJobDTO = { job: 'job-1', state: 'running', summary: null, error: null };
  const api: FakeHostsApi = {
    hosts,
    list: vi.fn(async () => [...hosts]),
    key: vi.fn(async () => ({ publicKey: `ssh-ed25519 ${BLOB} luady-fleet`, line: KEY_LINE })),
    create: vi.fn(async (body) => ({
      host: put(hostDto({ id: body.id, host: body.host, user: body.user, port: body.port, state: 'draft', link: null, kitVersion: null, kitAlias: null, projectsRoot: null })),
      grant: 'grant-1',
    })),
    createLocal: vi.fn(async (body) => ({
      host: put(hostDto({ id: 'computer', kind: 'local', host: 'localhost', user: 'me', terminal: false, kitVersion: null, projectsRoot: body.projectsRoot })),
      grant: 'grant-local',
    })),
    grant: vi.fn(async () => ({ grant: 'grant-2', expiresAt: '2026-11-21T08:10:00.000Z' })),
    scan: vi.fn(async () => ({ fingerprint: FP, keyType: 'ssh-ed25519', compare: 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' })),
    pin: vi.fn(async (id, fingerprint) => put({ ...find(id), state: 'pinned', fingerprint, link: 'online' })),
    check: vi.fn(async () => ({ auth: 'ok' as const, preflight: { os: 'Linux', ready: 'yes' }, missing: [] })),
    kit: vi.fn(async () => job),
    job: vi.fn(async () => null),
    update: vi.fn(async (id, body) => put({ ...find(id), ...(body.port === undefined ? {} : { port: body.port }) })),
    remove: vi.fn(async (id) => ({
      host: id, steps: { kit: 'done' as const, key: 'done' as const, link: 'closed' as const, record: 'removed' as const, rooms: 'kept' as const },
      note: null, keyCommand: null,
    })),
  };
  return api;
}

export function withHosts(api: HostsApi, ui: ReactElement): ReactElement {
  return <HostsApiProvider api={api}>{ui}</HostsApiProvider>;
}

/** Types the PIN into the PIN dialog and confirms. */
export async function enterPin(h: PageHarness, pin: string = PIN): Promise<void> {
  const field = await screen.findByLabelText('PIN');
  await h.user.type(field, pin);
  await h.user.click(screen.getByRole('button', { name: 'Confirm' }));
}
