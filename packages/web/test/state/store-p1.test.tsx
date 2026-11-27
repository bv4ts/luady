import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ownerZone, setOwnerZone } from '@luady/shared';
import { ApiProvider } from '../../src/api/context.js';
import { useWsMessage } from '../../src/api/ws.js';
import { StoreProvider, VERSIONS_DIFFER } from '../../src/state/store.js';
import { Toasts } from '../../src/ui/Toasts.js';
import { overview } from '../fixtures.js';
import { fakeApi, type FakeApi } from '../helpers/fake-api.js';
import { createFakeWs } from '../helpers/fake-ws.js';

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function mount(api: FakeApi, child = <Toasts />) {
  const ws = createFakeWs();
  render(
    <ApiProvider api={api}>
      <StoreProvider createWs={ws.factory} onAuthLost={vi.fn()}>{child}</StoreProvider>
    </ApiProvider>,
  );
  await flush();
  return ws;
}

afterEach(() => {
  setOwnerZone('Etc/GMT-4');
});

describe('StoreProvider: self host version, settings and live messages', () => {
  it('warns that the hub and website versions differ when the hub names another self host', async () => {
    await mount(fakeApi({ overview: async () => overview({ selfHost: 'lighthouse' }) }));
    expect(screen.getByText(VERSIONS_DIFFER)).toBeTruthy();
  });

  it('says nothing when the self host matches', async () => {
    await mount(fakeApi({ overview: async () => overview() }));
    expect(screen.queryByText(VERSIONS_DIFFER)).toBeNull();
  });

  it('loads the settings at start and sets the owner zone', async () => {
    await mount(fakeApi({ overview: async () => overview(), settings: async () => ({ ...DEFAULT_SETTINGS, owner_tz: 'America/New_York' }) }));
    expect(ownerZone()).toBe('America/New_York');
  });

  it('useWsMessage hands a live message of its type to the component', async () => {
    const seen: number[] = [];
    function Rooms() {
      useWsMessage('rooms.changed', (message) => seen.push(message.rooms.length));
      return null;
    }
    const ws = await mount(fakeApi({ overview: async () => overview() }), <Rooms />);
    ws.emit({ type: 'rooms.changed', rooms: [], at: '2026-11-21T08:00:00.000Z' });
    expect(seen).toEqual([0]);
  });
});
