import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddServerFlow } from '../../../src/features/hosts/AddServerFlow.js';
import { HostsSection } from '../../../src/features/hosts/HostsSection.js';
import { LocalHostForm } from '../../../src/features/hosts/LocalHostForm.js';
import { HostsApiProvider } from '../../../src/features/hosts/context.js';
import type { HostsApi } from '../../../src/api/hosts.js';
import { RoomsSection } from '../../../src/features/rooms/RoomsSection.js';
import { RoomsStep } from '../../../src/features/rooms/RoomsStep.js';
import { SETTINGS_SECTIONS, sectionsIn } from '../../../src/features/settings/sections.js';
import { SettingsPage } from '../../../src/features/settings/SettingsPage.js';
import { COMING_SOON } from '../../../src/ui/ComingSoon.js';
import { settings } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

// Sections that show the coming-soon placeholder: none.
const STUBS: readonly string[] = [];

describe('the Settings registry', () => {
  it('lists every section once, ordered within its area', () => {
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
    expect(sectionsIn('main').map((s) => s.id)).toEqual(['general', 'notifications']);
    expect(sectionsIn('side').map((s) => s.id)).toEqual(['office', 'rooms', 'hosts', 'channels', 'security', 'setup']);
    expect(sectionsIn('wide').map((s) => s.id)).toEqual(['audit']);
  });

  it('the Settings page renders the registry, every section filled', async () => {
    await renderPage(<SettingsPage />, {
      api: fakeApi({ settings: async () => settings(), actions: async () => [], passkeys: async () => ({ items: [] }) }),
    });
    for (const id of STUBS) expect(screen.getByTestId(id).textContent).toBe(COMING_SOON);
    expect(screen.getByTestId('rooms-section').textContent).not.toBe(COMING_SOON);
    expect(screen.getByTestId('hosts-section').textContent).not.toBe(COMING_SOON);
    expect(screen.getByTestId('setup-links').textContent).not.toBe(COMING_SOON);
    for (const title of ['General', 'Rooms', 'Servers', 'Channels', 'Setup']) expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByText(/Notifications, the office, rooms, servers, channels, security and the audit log\./)).toBeTruthy();
  });

  it('the rooms components keep their props: RoomsStep { onNext }, RoomsSection { }', async () => {
    const onNext = vi.fn();
    const h = await renderPage(<div><RoomsStep onNext={onNext} /><RoomsSection /></div>);
    expect(screen.getByTestId('rooms-step').textContent).not.toBe(COMING_SOON);
    expect(screen.getAllByTestId('rooms-manager').length).toBe(2);
    await h.user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('the hosts components keep their props: AddServerFlow { mode, onDone, onCancel }, LocalHostForm { onDone }, HostsSection { compact }', async () => {
    const onDone = vi.fn();
    const hosts = { list: async () => [], key: async () => ({ publicKey: '', line: '' }), job: async () => null } as unknown as HostsApi;
    await renderPage(
      <HostsApiProvider api={hosts}>
        <AddServerFlow mode="wizard" onDone={onDone} onCancel={vi.fn()} />
        <LocalHostForm onDone={onDone} />
        <HostsSection compact />
      </HostsApiProvider>,
    );
    for (const id of ['add-server-flow', 'local-host-form', 'hosts-section']) {
      expect(screen.getByTestId(id).textContent).not.toBe(COMING_SOON);
    }
    expect(onDone).not.toHaveBeenCalled();
  });
});
