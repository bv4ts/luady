import { describe, expect, it } from 'vitest';
import type { ChannelInfoDTO, HostDTO, RoomDTO, SetupStateDTO } from '@luady/shared';
import type { PageKeyCheck } from '../../src/web/server.js';
import { harnessFactory, ISO } from './helpers.js';
import { connectWs, listen, sleep, wsHeaders } from './ws-helpers.js';

const harness = harnessFactory();
const FAST = { wsSessionCheckMs: 60_000, transcriptDebounceMs: 20, transcriptPollMs: 60_000, wsAuthTimeoutMs: 150 };
const HELLO = { type: 'hello', now: ISO };
const KEY = 'k'.repeat(43);

const room: RoomDTO = {
  id: 'orchard', name: 'Orchard', short: 'Orchard', kind: 'server', host: 'birch', match: [], colour: '#d6336c', accent: '#e88fae',
  species: 'bun', position: 0, size: 'm', hostState: 'ok', createdAt: ISO, updatedAt: ISO,
};
const host: HostDTO = {
  id: 'mars', kind: 'ssh', host: 'mars.example.com', user: 'dev', port: 22, source: 'web', state: 'pinned', fingerprint: null, link: 'online',
  lastError: null, kitVersion: null, kitAlias: null, claudeVersion: null, claudeSignedIn: null, projectsRoot: null, homeDir: null,
  terminal: true, fromAddr: null, createdAt: ISO, updatedAt: ISO,
};
const channel: ChannelInfoDTO = {
  id: 'test-channel', kind: 'channel', name: 'Test', state: 'up', detail: null, since: ISO, primary: true, capabilities: null, panel: null,
};
const state: SetupStateDTO = { step: 'rooms', claimed: true, authMode: 'local', remote: false, skipped: [] };

async function setup(pageKey?: PageKeyCheck) {
  const h = await harness(pageKey === undefined ? {} : { pageKey }, FAST);
  const base = await listen(h);
  return { h, url: `${base}/ws`, session: h.login() };
}

describe('/ws events for rooms, hosts, host jobs, channels and setup', () => {
  it('fans out rooms, hosts, host jobs, channel status and setup to every client', async () => {
    const { h, url, session } = await setup();
    const a = await connectWs(url, wsHeaders(h, session));
    const b = await connectWs(url, wsHeaders(h, session));
    expect(await a.next()).toEqual(HELLO);
    expect(await b.next()).toEqual(HELLO);
    h.deps.bus.emit('rooms.changed', { rooms: [room], at: ISO });
    h.deps.bus.emit('hosts.changed', { hosts: [host], at: ISO });
    h.deps.bus.emit('host.job', { host: 'mars', job: 'j1', state: 'done', summary: 'installed' });
    h.deps.bus.emit('channel.status', { channel });
    h.deps.bus.emit('setup.changed', { state });
    const expected = [
      { type: 'rooms.changed', rooms: [room], at: ISO },
      { type: 'hosts.changed', hosts: [host], at: ISO },
      { type: 'host.job', host: 'mars', job: 'j1', state: 'done', summary: 'installed' },
      { type: 'channel.status', channel },
      { type: 'setup.changed', state },
    ];
    expect(await a.take(5)).toEqual(expected);
    expect(await b.take(5)).toEqual(expected);
    a.ws.close();
    b.ws.close();
  });

  it('sends host.log only to sockets subscribed to that host, until they unsubscribe', async () => {
    const { h, url, session } = await setup();
    const watcher = await connectWs(url, wsHeaders(h, session));
    const other = await connectWs(url, wsHeaders(h, session));
    await watcher.next();
    await other.next();
    watcher.ws.send(JSON.stringify({ type: 'subscribe.host', host: 'mars' }));
    other.ws.send(JSON.stringify({ type: 'subscribe.host', host: 'venus' }));
    await sleep(50);
    const line = { host: 'mars', job: 'j1', line: 'unpacking the kit', at: ISO };
    h.deps.bus.emit('host.log', line);
    expect(await watcher.next()).toEqual({ type: 'host.log', ...line });
    watcher.ws.send(JSON.stringify({ type: 'unsubscribe.host', host: 'mars' }));
    await sleep(50);
    h.deps.bus.emit('host.log', { ...line, line: 'after' });
    h.deps.bus.emit('setup.changed', { state });
    expect(await watcher.next()).toEqual({ type: 'setup.changed', state });
    expect(await other.next()).toEqual({ type: 'setup.changed', state });
    watcher.ws.close();
    other.ws.close();
  });

  it('accepts and ignores an auth message while the page-key rule is off', async () => {
    const { h, url, session } = await setup();
    const probe = await connectWs(url, wsHeaders(h, session));
    expect(await probe.next()).toEqual(HELLO);
    probe.ws.send(JSON.stringify({ type: 'auth', key: KEY }));
    probe.ws.send(JSON.stringify({ type: 'ping' }));
    expect(await probe.next()).toEqual(HELLO);
    probe.ws.close();
  });
});

describe('/ws page key, behind its flag', () => {
  const rule = (sid: () => string): PageKeyCheck => ({ required: () => true, matches: (s, key) => s === sid() && key === KEY });

  it('sends nothing, not even hello, until a matching auth arrives; then hello and the events', async () => {
    let sid = '';
    const { h, url, session } = await setup(rule(() => sid));
    sid = session.sid;
    const probe = await connectWs(url, wsHeaders(h, session));
    h.deps.bus.emit('setup.changed', { state });
    await sleep(30);
    probe.ws.send(JSON.stringify({ type: 'auth', key: KEY }));
    expect(await probe.next()).toEqual(HELLO);
    h.deps.bus.emit('setup.changed', { state });
    expect(await probe.next()).toEqual({ type: 'setup.changed', state });
    probe.ws.close();
  });

  it('closes with 4401 on a wrong key, on another first message, and when no auth comes in time', async () => {
    let sid = '';
    const { h, url, session } = await setup(rule(() => sid));
    sid = session.sid;
    const wrong = await connectWs(url, wsHeaders(h, session));
    wrong.ws.send(JSON.stringify({ type: 'auth', key: 'x'.repeat(43) }));
    expect((await wrong.closed).code).toBe(4401);
    const ping = await connectWs(url, wsHeaders(h, session));
    ping.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await ping.closed).code).toBe(4401);
    const silent = await connectWs(url, wsHeaders(h, session));
    expect((await silent.closed).code).toBe(4401);
  });
});
