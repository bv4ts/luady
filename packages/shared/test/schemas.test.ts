import { describe, expect, it } from 'vitest';
import {
  AddonToHubSchema, AddonToolDefSchema, ChannelInfoDTOSchema, ChannelSchema, GridDTOSchema, HostCreateBodySchema, HostDTOSchema,
  HostIdSchema, HubToAddonSchema, LOCAL_HOST_ID, NewHostIdSchema, NewRoomIdSchema, NoticeDTOSchema, RoomCreateBodySchema,
  RoomDTOSchema, RoomIdSchema, RoomImportSchema, SELF_HOST_ID, SessionDTOSchema, SetupStateDTOSchema, SetupStepBodySchema,
  WsClientMessageSchema, WsServerMessageSchema, isChatChannel, isLocalHost, isUnderRoot,
} from '../src/index.js';

const AT = '2026-11-21T08:00:00.000Z';

const session = {
  id: 'hq:manager:0.0', host: SELF_HOST_ID, target: 'manager:0.0', claudeSessionId: null, cwd: null, project: null,
  displayName: 'manager', state: 'idle', origin: 'system', registered: true, lastEventAt: null, turnStartedAt: null,
  pendingQid: null, unexpectedEnd: false,
} as const;

const host = {
  id: 'mars', kind: 'ssh', host: 'mars.example.com', user: 'dev', port: 22, source: 'web', state: 'pinned',
  fingerprint: `SHA256:${'a'.repeat(43)}`, link: 'online', lastError: null, kitVersion: '2.1.0', kitAlias: 'mars',
  claudeVersion: '2.1.300', claudeSignedIn: true, projectsRoot: '/home/dev/projects', homeDir: '/home/dev', terminal: true,
  fromAddr: null, createdAt: AT, updatedAt: AT,
} as const;

const room = {
  id: 'orchard', name: 'Orchard', short: 'Orchard', kind: 'server', host: 'birch', match: [], colour: '#d6336c', accent: '#e88fae',
  species: 'bun', position: 0, size: 'm', hostState: 'ok', createdAt: AT, updatedAt: AT,
} as const;

describe('which schema where', () => {
  it('SessionDTOSchema and HostDTOSchema accept the hosts hq and computer', () => {
    expect(SessionDTOSchema.safeParse(session).success).toBe(true);
    expect(SessionDTOSchema.safeParse({ ...session, id: 'computer:cc-x:0.0', host: LOCAL_HOST_ID }).success).toBe(true);
    expect(HostDTOSchema.safeParse({ ...host, id: LOCAL_HOST_ID, kind: 'local', terminal: false }).success).toBe(true);
    expect(HostDTOSchema.safeParse({ ...host, id: SELF_HOST_ID }).success).toBe(true);
  });

  it('NewHostIdSchema rejects both, and every reserved word or prefix; HostIdSchema is grammar only', () => {
    for (const id of [SELF_HOST_ID, LOCAL_HOST_ID, 'all', 'setup', 'codex', 'lot-3', 'vacant-1']) {
      expect(NewHostIdSchema.safeParse(id).success, id).toBe(false);
      expect(HostIdSchema.safeParse(id).success, id).toBe(true);
    }
    expect(NewHostIdSchema.safeParse('mars-2').success).toBe(true);
    for (const id of ['M', 'a', 'x:y', '-ab', 'ab-', 'a'.repeat(25)]) expect(HostIdSchema.safeParse(id).success, id).toBe(false);
    expect(isLocalHost(LOCAL_HOST_ID)).toBe(true);
    expect(isLocalHost(SELF_HOST_ID)).toBe(false);
  });

  it('POST /api/hosts takes a new host id only', () => {
    const body = { id: 'mars', host: 'mars.example.com', user: 'dev', port: 22, pin: '123456' };
    expect(HostCreateBodySchema.safeParse(body).success).toBe(true);
    expect(HostCreateBodySchema.safeParse({ ...body, id: LOCAL_HOST_ID }).success).toBe(false);
    expect(HostCreateBodySchema.safeParse({ ...body, host: '-oProxyCommand=x' }).success).toBe(false);
  });
});

describe('rooms', () => {
  it('RoomIdSchema is grammar only; NewRoomIdSchema refuses reserved ids and the lot- prefix', () => {
    expect(RoomIdSchema.safeParse('hq').success).toBe(true);
    for (const id of ['hq', 'lobby', 'lot-4', 'vacant-2']) expect(NewRoomIdSchema.safeParse(id).success, id).toBe(false);
    expect(NewRoomIdSchema.safeParse('shop-api').success).toBe(true);
    expect(RoomIdSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('a room carries hostState; a create may name a position; an import needs id and position', () => {
    expect(RoomDTOSchema.parse(room)).toEqual(room);
    expect(RoomDTOSchema.safeParse({ ...room, hostState: 'gone' }).success).toBe(false);
    expect(RoomCreateBodySchema.parse({ name: 'Shop', kind: 'project', position: 5 })).toEqual({ name: 'Shop', kind: 'project', position: 5 });
    expect(RoomCreateBodySchema.safeParse({ name: 'Shop', kind: 'project', position: -1 }).success).toBe(false);
    expect(RoomImportSchema.safeParse({ name: 'Shop', kind: 'project' }).success).toBe(false);
    expect(RoomImportSchema.safeParse({ name: 'Shop', kind: 'project', id: 'shop', position: 0 }).success).toBe(true);
  });

  it('GridDTO has slotCount, and capacity is at least 4', () => {
    expect(GridDTOSchema.safeParse({ slotCount: 0, K: 1, R: 1, capacity: 4 }).success).toBe(true);
    expect(GridDTOSchema.safeParse({ slotCount: 0, K: 1, R: 1, capacity: 3 }).success).toBe(false);
  });
});

describe('setup', () => {
  it('pins the steps and the skippable ones', () => {
    expect(SetupStateDTOSchema.safeParse({ step: 'rooms', claimed: true, authMode: 'local', remote: false, skipped: ['passkey'] }).success).toBe(true);
    expect(SetupStepBodySchema.safeParse({ step: 'pin', action: 'skip' }).success).toBe(false);
  });
});

describe('channels and add-ons', () => {
  it('channel ids are open: the built-ins or the add-on grammar, never a role name', () => {
    expect(ChannelSchema.safeParse('test-channel').success).toBe(true);
    expect(ChannelSchema.safeParse('manager').success).toBe(false);
    expect(isChatChannel('chat-two')).toBe(true);
    expect(isChatChannel('test-channel')).toBe(true);
    for (const channel of ['web', 'phone', 'event', 'scheduled', 'remote_control', null, undefined]) expect(isChatChannel(channel), String(channel)).toBe(false);
  });

  it('ChannelInfoDTO.state is the channel state or absent', () => {
    const info = { id: 'test-channel', kind: 'channel', name: 'Test', state: 'absent', detail: null, since: null, primary: true, capabilities: null, panel: null };
    expect(ChannelInfoDTOSchema.safeParse(info).success).toBe(true);
    expect(ChannelInfoDTOSchema.safeParse({ ...info, state: 'open' }).success).toBe(false);
  });

  it('AddonToolDef has its limits; a channel hello must declare capabilities', () => {
    const tool = { name: 'video_download', description: 'Download a video.', input: { type: 'object' } };
    expect(AddonToolDefSchema.safeParse(tool).success).toBe(true);
    expect(AddonToolDefSchema.safeParse({ ...tool, name: 'Video' }).success).toBe(false);
    expect(AddonToolDefSchema.safeParse({ ...tool, description: 'x'.repeat(1001) }).success).toBe(false);
    expect(AddonToolDefSchema.safeParse({ ...tool, input: { big: 'x'.repeat(17_000) } }).success).toBe(false);
    expect(AddonToHubSchema.safeParse({ t: 'hello', protocol: 1, kind: 'channel', version: '1.0.0' }).success).toBe(false);
    expect(AddonToHubSchema.safeParse({ t: 'hello', protocol: 1, kind: 'tools', version: '1.0.0', tools: [tool] }).success).toBe(true);
  });

  it('deliver.file.kind includes video; the hub sends welcome with the owner', () => {
    const file = { kind: 'video', path: '/data/addons/video/files/a.mp4', mime: 'video/mp4', fileName: 'a.mp4', caption: '' };
    expect(AddonToHubSchema.safeParse({ t: 'deliver', ref: 'r1', file }).success).toBe(true);
    expect(HubToAddonSchema.safeParse({ t: 'welcome', protocol: 1, hub: '0.1.0', manager: { name: 'Luady' }, owner: null }).success).toBe(true);
  });

  it('NoticeDTO may carry a file', () => {
    const notice = { id: 'n1', kind: 'result', text: 'x', ref: null, createdAt: AT, chatDueAt: null, chatSentAt: null, settledAt: null, settledVia: null };
    expect(NoticeDTOSchema.safeParse({ ...notice, file: { id: 'f1', name: 'a.pdf', mime: 'application/pdf', size: 10 } }).success).toBe(true);
  });
});

describe('WebSocket', () => {
  it('has the room, host, channel and setup server messages', () => {
    for (const message of [
      { type: 'rooms.changed', rooms: [room], at: AT },
      { type: 'hosts.changed', hosts: [host], at: AT },
      { type: 'host.job', host: 'mars', job: 'j1', state: 'done', summary: 'installed' },
      { type: 'host.log', host: 'mars', job: 'j1', line: 'unpacking', at: AT },
      { type: 'setup.changed', state: { step: 'done', claimed: true, authMode: 'local', remote: false, skipped: [] } },
    ]) expect(WsServerMessageSchema.safeParse(message).success, message.type).toBe(true);
    expect(WsServerMessageSchema.safeParse({ type: 'host.log', host: 'mars', job: 'j1', line: 'x'.repeat(501), at: AT }).success).toBe(false);
  });

  it('has the client messages subscribe.host, unsubscribe.host and auth', () => {
    expect(WsClientMessageSchema.safeParse({ type: 'subscribe.host', host: 'mars' }).success).toBe(true);
    expect(WsClientMessageSchema.safeParse({ type: 'unsubscribe.host', host: 'mars' }).success).toBe(true);
    expect(WsClientMessageSchema.safeParse({ type: 'auth', key: 'k'.repeat(43) }).success).toBe(true);
    expect(WsClientMessageSchema.safeParse({ type: 'subscribe.host', host: 'Mars' }).success).toBe(false);
  });
});

describe('isUnderRoot', () => {
  it('checks a path against the given root', () => {
    expect(isUnderRoot('/srv/work/shop', '/srv/work')).toBe(true);
    expect(isUnderRoot('/srv/work', '/srv/work/')).toBe(true);
    expect(isUnderRoot('/srv/workshop', '/srv/work')).toBe(false);
    expect(isUnderRoot('/srv/work/../etc', '/srv/work')).toBe(false);
    expect(isUnderRoot('srv/work/x', '/srv/work')).toBe(false);
    expect(isUnderRoot('/srv/work/x', 'relative')).toBe(false);
    expect(isUnderRoot('/anything', '/')).toBe(true);
  });
});
