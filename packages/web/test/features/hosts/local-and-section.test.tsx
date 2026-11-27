import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { HostsSection } from '../../../src/features/hosts/HostsSection.js';
import { LocalHostForm } from '../../../src/features/hosts/LocalHostForm.js';
import { REMOVE_DEFAULTS } from '../../../src/features/hosts/RemoveHostDialog.js';
import { overview } from '../../fixtures.js';
import { renderPage } from '../../helpers/render.js';
import { hostDto } from '../../room-fixtures.js';
import { BLOB, PIN, enterPin, fakeHostsApi, withHosts } from './hosts-fixtures.js';

vi.mock('../../../src/features/rooms/creature-preview.js', () => ({ CREATURE_PX: 24, drawCreature: vi.fn(async () => false) }));

describe('"Add this computer"', () => {
  it('the folder is prefilled ~/projects with "create it if missing"; then the PIN, the check, the kit and the room', async () => {
    const api = fakeHostsApi();
    const onDone = vi.fn();
    const h = await renderPage(withHosts(api, <LocalHostForm onDone={onDone} />), { overview: overview({ servers: [], rooms: [] }) });
    expect((screen.getByLabelText('Projects folder') as HTMLInputElement).value).toBe('~/projects');
    expect((screen.getByLabelText(/Create it if missing/) as HTMLInputElement).checked).toBe(true);
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    await enterPin(h);
    await waitFor(() => expect(api.createLocal).toHaveBeenCalledWith({ projectsRoot: '~/projects', createFolder: true, pin: PIN }));

    expect((await screen.findByTestId('host-step-check')).textContent).toContain('Python 3.10 or later, tmux and Claude Code');
    await h.user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(api.check).toHaveBeenCalledWith('computer', 'grant-local');
    expect(api.grant).not.toHaveBeenCalled();
    await h.user.click(await screen.findByRole('button', { name: 'Go on' }));
    expect(screen.getByTestId('host-step-kit').textContent).toContain('~/.luady in your home');
    await h.user.click(screen.getByRole('button', { name: 'Install the kit' }));
    act(() => h.ws.emit({ type: 'host.job', host: 'computer', job: 'job-1', state: 'done', summary: 'Kit 2.1.0 is on computer.' }));
    await h.user.click(await screen.findByRole('button', { name: 'Go on' }));
    expect((await screen.findByTestId('host-step-room')).textContent).toContain('Give this computer a room');
  });

  it('a refused folder says what to do next', async () => {
    const api = fakeHostsApi();
    api.createLocal.mockRejectedValueOnce(new ApiError(400, 'folder_outside_home', 'raw'));
    const h = await renderPage(withHosts(api, <LocalHostForm onDone={() => undefined} />), { overview: overview({ servers: [], rooms: [] }) });
    await h.user.clear(screen.getByLabelText('Projects folder'));
    await h.user.type(screen.getByLabelText('Projects folder'), '/srv/work');
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    await enterPin(h);
    expect(await screen.findByText(/A new folder can only be made inside your home folder/)).toBeTruthy();
  });

  it('a folder the hub refuses as invalid is named as the folder, never as the name, address, user or port', async () => {
    for (const code of ['validation', 'folder_invalid']) {
      const api = fakeHostsApi();
      api.createLocal.mockRejectedValueOnce(new ApiError(400, code, 'raw'));
      const h = await renderPage(withHosts(api, <LocalHostForm onDone={() => undefined} />), { overview: overview({ servers: [], rooms: [] }) });
      await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
      await enterPin(h);
      expect(await screen.findByText(/The hub cannot use that folder\. Give a full path such as ~\/projects/)).toBeTruthy();
      expect(screen.queryByText(/the address, the user and the port/)).toBeNull();
      h.unmount();
    }
  });

  it('on a hub that runs on Windows it says plainly that this computer needs Linux or WSL2', async () => {
    const api = fakeHostsApi();
    api.createLocal.mockRejectedValueOnce(new ApiError(400, 'local_unsupported', 'raw'));
    const h = await renderPage(withHosts(api, <LocalHostForm onDone={() => undefined} />), { overview: overview({ servers: [], rooms: [] }) });
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    await enterPin(h);
    expect(await screen.findByText(/This computer can be added only when the hub runs on Linux or in WSL2/)).toBeTruthy();
  });

  it('a folder with odd characters is refused before the PIN', async () => {
    const api = fakeHostsApi();
    const h = await renderPage(withHosts(api, <LocalHostForm onDone={() => undefined} />), { overview: overview({ servers: [], rooms: [] }) });
    await h.user.clear(screen.getByLabelText('Projects folder'));
    await h.user.type(screen.getByLabelText('Projects folder'), '~/a b;c');
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    expect(screen.getByText(/Enter a folder such as ~\/projects/)).toBeTruthy();
    expect(screen.queryByLabelText('PIN')).toBeNull();
  });
});

describe('the servers list (Settings → Servers)', () => {
  const MARS = hostDto({ id: 'mars', host: 'mars.example.com', kitVersion: '2.1.0' });
  const CEDAR = hostDto({ id: 'cedar', host: 'cedar.example.com', source: 'config', kitVersion: '2.1.0' });
  const DRAFT = hostDto({ id: 'venus', host: 'venus.example.com', state: 'draft', link: null, kitVersion: null });

  async function section(hosts = [MARS, CEDAR, DRAFT]) {
    const api = fakeHostsApi(hosts);
    const h = await renderPage(withHosts(api, <HostsSection />), { overview: overview({ servers: [], rooms: [] }) });
    await screen.findByTestId(`host-row-${hosts[0]?.id ?? 'none'}`);
    return { api, h };
  }

  it('shows state, address, kit and source; config rows are read-only; unfinished ones can be continued', async () => {
    await section();
    const mars = screen.getByTestId('host-row-mars');
    expect(mars.textContent).toContain('dev@mars.example.com:22');
    expect(mars.textContent).toContain('kit 2.1.0');
    expect(within(mars).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(mars).getByRole('button', { name: 'Continue setup' })).toBeTruthy();
    const cedar = screen.getByTestId('host-row-cedar');
    expect(cedar.textContent).toContain('from config.json');
    expect(within(cedar).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(cedar).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(cedar).getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(within(cedar).getByRole('button', { name: 'Update kit' })).toBeTruthy();
    expect(screen.getByTestId('host-row-venus').textContent).toContain('Not confirmed yet');
    expect(screen.getByRole('button', { name: 'Add this computer' })).toBeTruthy();
  });

  it('the setup wizard\'s short list offers the kit of a server from config.json, which has no "Continue setup"', async () => {
    const BARE = hostDto({ id: 'cedar', host: 'cedar.example.com', source: 'config', kitVersion: null });
    const api = fakeHostsApi([MARS, BARE]);
    await renderPage(withHosts(api, <HostsSection compact />), { overview: overview({ servers: [], rooms: [] }) });
    const cedar = await screen.findByTestId('host-row-cedar');
    expect(within(cedar).getByRole('button', { name: 'Install kit' })).toBeTruthy();
    expect(within(cedar).queryByRole('button', { name: 'Continue setup' })).toBeNull();
    // A server added on the website goes on through "Continue setup" there; the short list stays short for it.
    const mars = screen.getByTestId('host-row-mars');
    expect(within(mars).queryByRole('button', { name: 'Update kit' })).toBeNull();
    expect(within(mars).queryByRole('button', { name: 'Check' })).toBeNull();
  });

  it('follows hosts.changed', async () => {
    const { h } = await section();
    act(() => h.ws.emit({ type: 'hosts.changed', hosts: [MARS], at: '2026-11-21T08:00:00.000Z' }));
    await waitFor(() => expect(screen.queryByTestId('host-row-cedar')).toBeNull());
  });

  it('the remove dialog removes the kit and the key line and keeps the rooms by default', async () => {
    expect(REMOVE_DEFAULTS).toEqual({ uninstallKit: true, removeKey: true, rooms: 'keep' });
    const { api, h } = await section();
    await h.user.click(within(screen.getByTestId('host-row-mars')).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByTestId('host-remove-dialog');
    expect((within(dialog).getByLabelText(/Remove the kit from mars/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(/Remove the hub's key line from mars/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(/Keep them/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(/Delete them/) as HTMLInputElement).checked).toBe(false);
    api.remove.mockResolvedValueOnce({
      host: 'mars', steps: { kit: 'unreachable', key: 'unreachable', link: 'closed', record: 'removed', rooms: 'kept' },
      note: 'The hub could not reach mars, so the kit and the hub\'s key line may still be on it.',
      keyCommand: `grep -vF '${BLOB}' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new`,
    });
    await h.user.click(screen.getByRole('button', { name: 'Remove mars' }));
    await enterPin(h);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('mars', { uninstallKit: true, removeKey: true, rooms: 'keep', pin: PIN }));
    const result = await screen.findByTestId('host-remove-result');
    expect(result.textContent).toContain('could not reach mars');
    expect(within(result).getByTestId('host-key-command').textContent).toContain(BLOB);
  });

  it('this computer has no key line to remove', async () => {
    const { api, h } = await section([hostDto({ id: 'computer', kind: 'local', host: 'localhost', terminal: false })]);
    await h.user.click(within(screen.getByTestId('host-row-computer')).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByTestId('host-remove-dialog');
    expect(within(dialog).queryByLabelText(/key line/)).toBeNull();
    await h.user.click(within(dialog).getByLabelText(/Delete them/));
    await h.user.click(screen.getByRole('button', { name: 'Remove this computer' }));
    await enterPin(h);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('computer', { uninstallKit: true, removeKey: false, rooms: 'delete', pin: PIN }));
    expect(screen.queryByRole('button', { name: 'Add this computer' })).toBeNull();
  });

  it('editing the port warns that the fingerprint is checked again', async () => {
    const { api, h } = await section();
    await h.user.click(within(screen.getByTestId('host-row-mars')).getByRole('button', { name: 'Edit' }));
    const port = await screen.findByLabelText('Port');
    await h.user.clear(port);
    await h.user.type(port, '2222');
    expect(screen.getByText(/means a new fingerprint check/)).toBeTruthy();
    await h.user.click(screen.getByRole('button', { name: 'Save' }));
    await enterPin(h);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('mars', { port: 2222, pin: PIN }));
  });

  it('a check from the list asks the PIN once for a grant, then shows what it found', async () => {
    const { api, h } = await section();
    await h.user.click(within(screen.getByTestId('host-row-mars')).getByRole('button', { name: 'Check' }));
    await h.user.click(await screen.findByRole('button', { name: 'Check now' }));
    await enterPin(h);
    await waitFor(() => expect(api.check).toHaveBeenCalledWith('mars', 'grant-2'));
    expect((await screen.findByTestId('host-check-result')).textContent).toContain('everything the kit needs is there');
  });

  it('every control is a labelled button or field (keyboard reachable)', async () => {
    await section();
    const buttons = screen.getAllByRole('button');
    expect(buttons.every((button) => (button.textContent ?? '').trim() !== '' || button.getAttribute('aria-label') !== null)).toBe(true);
  });
});
