import { act, screen, waitFor, within } from '@testing-library/react';
import type { HostDTO, SetupStateDTO } from '@luady/shared';
import { useMemo, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import type { SetupApi } from '../../../src/api/setup.js';
import { SetupApiProvider, SetupStateProvider } from '../../../src/features/setup/context.js';
import { SetupLinks } from '../../../src/features/setup/SetupLinks.js';
import { SetupChanges, SetupGuard, SetupWizard } from '../../../src/features/setup/SetupWizard.js';
import { zoneLine } from '../../../src/features/setup/steps.js';
import { MANAGER_PLAIN_WORDS } from '../../../src/features/settings/ManagerSwitch.js';
import { settings } from '../../fixtures.js';
import { fakeApi, type FakeApi } from '../../helpers/fake-api.js';
import { fakeSetupApi, setupState, type FakeSetupApi } from '../../helpers/fake-setup.js';
import { renderPage } from '../../helpers/render.js';

// The components of the hosts, rooms and channels features are stubs here (their own tests cover them): the wizard is
// tested for what it shows and how it moves on.
const stubs = vi.hoisted(() => ({ hosts: [] as HostDTO[], addServerProps: [] as unknown[], hostsSectionProps: [] as unknown[] }));

vi.mock('../../../src/features/hosts/LocalHostForm.js', () => ({
  LocalHostForm: ({ onDone }: { onDone: (r: { host: string; room: string | null }) => void }) => (
    <div data-testid="local-host-form"><button type="button" onClick={() => onDone({ host: 'computer', room: 'computer' })}>Stub done</button></div>
  ),
}));
vi.mock('../../../src/features/hosts/AddServerFlow.js', () => ({
  AddServerFlow: (props: { mode: string; onDone: (r: { host: string; room: string | null }) => void; onCancel: () => void }) => {
    stubs.addServerProps.push(props);
    return (
      <div data-testid="add-server-flow" data-mode={props.mode}>
        <button type="button" onClick={() => props.onDone({ host: 'birch', room: 'orchard' })}>Stub done</button>
        <button type="button" onClick={props.onCancel}>Stub cancel</button>
      </div>
    );
  },
}));
vi.mock('../../../src/features/hosts/HostsSection.js', () => ({
  HostsSection: (props: { compact?: boolean }) => {
    stubs.hostsSectionProps.push(props);
    return <div data-testid="hosts-section" data-compact={String(props.compact)} />;
  },
}));
vi.mock('../../../src/features/hosts/store.js', () => ({
  useHostList: () => ({ hosts: stubs.hosts, error: null, refresh: async () => stubs.hosts }),
}));
vi.mock('../../../src/features/rooms/RoomsStep.js', () => ({
  RoomsStep: ({ onNext }: { onNext: () => void }) => (
    <section data-testid="rooms-step"><button type="button" onClick={onNext}>Skip for now</button></section>
  ),
}));
vi.mock('../../../src/features/channels/ChannelsSection.js', () => ({
  ChannelsSection: ({ compact }: { compact?: boolean }) => <div data-testid="channels-none" data-compact={String(compact)}>No chat channel is connected.</div>,
}));
vi.mock('../../../src/features/channels/ConnectServices.js', () => ({ ConnectServices: () => <div data-testid="connect-services" /> }));
vi.mock('../../../src/features/agency/drawers/LoginFlow.js', () => ({
  LoginFlow: ({ host }: { host: string }) => <div data-testid={`login-flow-${host}`} />,
}));
const manager = vi.hoisted(() => ({ view: vi.fn() }));
vi.mock('../../../src/features/settings/manager-switch-api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/features/settings/manager-switch-api.js')>();
  return { ...real, managerSwitchApi: { view: manager.view, requirePinOff: vi.fn() } };
});

function host(over: Partial<HostDTO>): HostDTO {
  return {
    id: 'birch', kind: 'ssh', source: 'web', state: 'pinned', host: '192.0.2.21', user: 'dev', port: 22, hostKeyFp: null, projectsRoot: null,
    homeDir: null, claudeBin: null, fromAddr: null, fromLocked: false, link: 'online', lastError: null, kitVersion: '1.0.0', claudeVersion: '2.1.295',
    claudeSignedIn: false, terminal: true, createdAt: null, updatedAt: null, ...over,
  } as HostDTO;
}

/** The wizard with a state that moves as the answers come in, as the gate keeps it. */
function Wizard({ initial, api, children }: { initial: SetupStateDTO; api: SetupApi; children: React.ReactNode }) {
  const [state, setState] = useState<SetupStateDTO | null>(initial);
  const value = useMemo(() => ({ state, apply: setState, refresh: async () => undefined }), [state]);
  return (
    <SetupApiProvider api={api}>
      <SetupStateProvider value={value}>
        <SetupChanges />
        <output data-testid="setup-step">{state?.step}</output>
        {children}
      </SetupStateProvider>
    </SetupApiProvider>
  );
}

async function open(route: string, initial: SetupStateDTO, after: SetupStateDTO[] = [], api: FakeApi = fakeApi(), stored = settings()) {
  const setup: FakeSetupApi = fakeSetupApi(after.length > 0 ? after : [initial]);
  api.settings.mockResolvedValue(stored);
  api.accounts.mockResolvedValue({
    accounts: [],
    connections: [
      { id: 'google', label: 'Google', state: 'unavailable', detail: null, connectUrl: null },
      { id: 'wispr', label: 'Wispr Flow', state: 'not_connected', detail: null, connectUrl: null },
      { id: 'jira', label: 'Jira · Orchard', state: 'connected', detail: null, connectUrl: null },
    ],
  });
  const page = await renderPage(<Wizard initial={initial} api={setup}><SetupWizard /></Wizard>, { api, route, path: 'setup/*' });
  return { ...page, setup };
}

const at = (step: SetupStateDTO['step']) => setupState({ step, claimed: true });
const location = () => screen.getByTestId('location').textContent;

beforeEach(() => {
  stubs.hosts = [];
  stubs.addServerProps = [];
  stubs.hostsSectionProps = [];
  manager.view.mockReset();
  manager.view.mockResolvedValue({ enabled: false, state: 'off', steps: [], signIn: false });
});

describe('the rooms step', () => {
  it('offers "Add this computer" and "Add a server" as empty lots, says what a server needs, and lists the rooms', async () => {
    await open('/setup/rooms', at('rooms'));
    expect(screen.getByRole('heading', { name: 'Add your rooms' })).toBeTruthy();
    expect(screen.getByTestId('setup-add-computer').textContent).toMatch(/Add this computer/);
    expect(screen.getByTestId('setup-add-server').textContent).toMatch(/Add a server/);
    expect(screen.getByTestId('setup-server-needs').textContent).toBe('A server needs SSH as a normal user (not root), python3, tmux and Claude Code.');
    expect(screen.getByTestId('rooms-step')).toBeTruthy();
  });

  it('"Add this computer" opens the local host form; when it is done the lots come back with a note', async () => {
    const { user } = await open('/setup/rooms', at('rooms'));
    await user.click(screen.getByTestId('setup-add-computer'));
    expect(screen.getByTestId('local-host-form')).toBeTruthy();
    expect(screen.queryByTestId('rooms-step')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stub done' }));
    expect(screen.getByText('This computer is added.')).toBeTruthy();
    expect(screen.getByTestId('setup-add-computer')).toBeTruthy();
  });

  it('"Add a server" opens the add-server flow in its wizard mode; cancel or "Back to rooms" return', async () => {
    const { user } = await open('/setup/rooms', at('rooms'));
    await user.click(screen.getByTestId('setup-add-server'));
    expect(screen.getByTestId('add-server-flow').getAttribute('data-mode')).toBe('wizard');
    await user.click(screen.getByRole('button', { name: 'Stub cancel' }));
    expect(screen.getByTestId('setup-add-server')).toBeTruthy();
    await user.click(screen.getByTestId('setup-add-server'));
    await user.click(screen.getByRole('button', { name: 'Back to rooms' }));
    expect(screen.getByTestId('setup-add-server')).toBeTruthy();
    await user.click(screen.getByTestId('setup-add-server'));
    await user.click(screen.getByRole('button', { name: 'Stub done' }));
    expect(screen.getByText('birch is added.')).toBeTruthy();
  });

  it('says this computer is added once it is', async () => {
    stubs.hosts = [host({ id: 'computer', kind: 'local', host: 'localhost' })];
    await open('/setup/rooms', at('rooms'));
    expect(screen.getByTestId('setup-add-computer').textContent).toMatch(/Added\./);
  });

  it('going on without rooms records a skip and opens the connect step', async () => {
    const { user, setup } = await open('/setup/rooms', at('rooms'), [at('connect')]);
    await user.click(within(screen.getByTestId('rooms-step')).getByRole('button', { name: 'Skip for now' }));
    expect(setup.step).toHaveBeenCalledWith({ step: 'rooms', action: 'skip' });
    await waitFor(() => expect(location()).toBe('/setup/connect'));
    expect(screen.getByRole('heading', { name: 'Connect your machines' })).toBeTruthy();
  });

  it('a step the hub refuses says so and stays', async () => {
    const { user, setup } = await open('/setup/rooms', at('rooms'));
    setup.step.mockRejectedValue(new ApiError(409, 'refused', 'Finish the rooms step first.'));
    await user.click(within(screen.getByTestId('rooms-step')).getByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText('This step was not saved: Finish the rooms step first.')).toBeTruthy();
    expect(location()).toBe('/setup/rooms');
  });
});

describe('the connect step', () => {
  it('warns that sessions run with permissions bypassed, lists the machines (short form) and their Claude sign-in', async () => {
    stubs.hosts = [
      host({ id: 'computer', kind: 'local', host: 'localhost' }),
      host({ id: 'birch', claudeSignedIn: true }),
      host({ id: 'cedar', kitVersion: null }),
    ];
    const { user } = await open('/setup/connect', at('connect'));
    expect(screen.getByTestId('setup-bypass-warning').textContent).toMatch(/permissions bypassed/);
    expect(screen.getByTestId('hosts-section').getAttribute('data-compact')).toBe('true');
    expect(screen.getByText('Signed in to Claude')).toBeTruthy();
    expect(screen.getByText(/Install the kit first/)).toBeTruthy();
    expect(screen.getByText('This computer')).toBeTruthy();
    await user.click(screen.getByTestId('setup-signin-computer'));
    expect(screen.getByTestId('login-flow-computer')).toBeTruthy();
  });

  it('without machines only "Skip for now" is offered; with machines, Next moves on', async () => {
    await open('/setup/connect', at('connect'));
    expect(screen.queryByTestId('setup-next')).toBeNull();
    expect(screen.getByTestId('setup-skip').textContent).toBe('Skip for now');
  });

  it('Next records the step as done and opens the extras', async () => {
    stubs.hosts = [host({})];
    const { user, setup } = await open('/setup/connect', at('connect'), [at('extras')]);
    await user.click(screen.getByTestId('setup-next'));
    expect(setup.step).toHaveBeenCalledWith({ step: 'connect', action: 'done' });
    await waitFor(() => expect(location()).toBe('/setup/extras'));
  });
});

describe('the extras step', () => {
  it('the manager box starts unticked, with the plain words on what it may touch', async () => {
    await open('/setup/extras', at('extras'));
    const box = await screen.findByRole('switch', { name: /Use the manager/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(MANAGER_PLAIN_WORDS)).toBeTruthy();
  });

  it('the five nightly switches are all off, the channel note is calm, and the modules say how to switch them on', async () => {
    await open('/setup/extras', at('extras'));
    const nightly = await screen.findByTestId('setup-nightly');
    const switches = within(nightly).getAllByRole('switch') as HTMLInputElement[];
    expect(switches).toHaveLength(5);
    expect(switches.every((one) => !one.checked)).toBe(true);
    expect(screen.getByTestId('channels-none').getAttribute('data-compact')).toBe('true');
    const modules = await screen.findByTestId('setup-modules');
    expect(within(modules).getByText('Not set up')).toBeTruthy();
    expect(within(modules).getByText(/secrets\.env/)).toBeTruthy();
    expect(within(modules).getByText('Connected')).toBeTruthy();
    expect(screen.getByTestId('connect-services')).toBeTruthy();
  });

  it('a nightly switch is saved only when the owner flips it', async () => {
    const api = fakeApi();
    api.updateSettings.mockResolvedValue(settings({ claude_update_enabled: true }));
    const { user } = await open('/setup/extras', at('extras'), [], api);
    expect(api.updateSettings).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('switch', { name: 'Claude Code update' }));
    expect(api.updateSettings).toHaveBeenCalledWith({ claude_update_enabled: true });
  });

  it('Next goes to the summary, which opens the office', async () => {
    stubs.hosts = [host({})];
    const { user, setup } = await open('/setup/extras', at('extras'), [at('extras'), setupState({ step: 'done', claimed: true })]);
    await user.click(screen.getByTestId('setup-next'));
    expect(setup.step).toHaveBeenCalledWith({ step: 'extras', action: 'done' });
    await waitFor(() => expect(location()).toBe('/setup/open'));
    expect(screen.getByTestId('setup-summary').textContent).toMatch(/Machines: 1 machine, 1 with the kit/);
    await waitFor(() => expect(screen.getByTestId('setup-summary').textContent).toMatch(/Manager: off/));
    await user.click(screen.getByTestId('setup-finish'));
    expect(setup.finish).toHaveBeenCalled();
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('the summary says in one line which zone times are shown in', async () => {
    await open('/setup/open', at('extras'), [], fakeApi(), settings({ owner_tz: 'America/Chicago' }));
    await waitFor(() => expect(screen.getByTestId('setup-zone').textContent).toBe('Times are shown in America/Chicago. You can change this in Settings.'));
  });
});

describe('the time zone line', () => {
  it('names the stored zone, else the zone the page uses meanwhile', () => {
    expect(zoneLine('Australia/Sydney', 'America/Chicago')).toBe('Times are shown in Australia/Sydney. You can change this in Settings.');
    expect(zoneLine(null, 'America/Chicago')).toBe("Times are shown in this browser's time zone (America/Chicago) until you save one in Settings.");
    expect(zoneLine(null, null)).toBe('Times are shown in UTC until you choose your time zone in Settings.');
  });
});

describe('where the wizard leads', () => {
  it('an address ahead of the state leads back to the current step', async () => {
    await open('/setup/extras', at('rooms'));
    await waitFor(() => expect(location()).toBe('/setup/rooms'));
  });

  it('a step already passed may be seen again; the summary is reached only from the extras', async () => {
    await open('/setup/rooms', at('connect'));
    expect(location()).toBe('/setup/rooms');
    await open('/setup/open', at('connect'));
    await waitFor(() => expect(screen.getAllByTestId('location').at(-1)?.textContent).toBe('/setup/connect'));
  });

  it('a finished setup sends /setup to the office', async () => {
    await open('/setup/rooms', setupState({ step: 'done', claimed: true }));
    await waitFor(() => expect(location()).toBe('/'));
  });

  it('while setup is not done, every other page leads to the current step', async () => {
    const setup = fakeSetupApi([at('connect')]);
    await renderPage(<Wizard initial={at('connect')} api={setup}><SetupGuard><p>The office</p></SetupGuard></Wizard>, { route: '/settings' });
    await waitFor(() => expect(location()).toBe('/setup/connect'));
  });

  it('a setup.changed message from the hub moves the state', async () => {
    const { ws } = await open('/setup/rooms', at('rooms'));
    act(() => ws.emit({ type: 'setup.changed', state: at('connect') }));
    expect(screen.getByTestId('setup-step').textContent).toBe('connect');
  });

  it('the step list marks the current step and says which were skipped', async () => {
    await open('/setup/connect', setupState({ step: 'connect', claimed: true, skipped: ['passkey', 'rooms'] }));
    const steps = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(steps).getByText('Connect').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(steps.textContent).toMatch(/Claim \(skipped\)/);
    expect(steps.textContent).toMatch(/Rooms \(skipped\)/);
    expect(within(steps).getByRole('link', { name: /Rooms/ }).getAttribute('href')).toBe('/setup/rooms');
  });
});

describe('Settings: Setup (every step again)', () => {
  it('opens the rooms, connect and extras screens; Done closes them without moving the setup state', async () => {
    const api = fakeApi();
    api.settings.mockResolvedValue(settings());
    api.accounts.mockResolvedValue({ accounts: [], connections: [] });
    const { user } = await renderPage(<SetupLinks />, { api });
    expect(screen.getByTestId('setup-links').textContent).toMatch(/Passkeys and the PIN: see Security\./);
    await user.click(screen.getByTestId('setup-link-rooms'));
    expect(screen.getByTestId('setup-add-computer')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Close/ }));
    await user.click(screen.getByTestId('setup-link-extras'));
    expect(await screen.findByRole('switch', { name: /Use the manager/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('switch', { name: /Use the manager/ })).toBeNull();
    await user.click(screen.getByTestId('setup-link-connect'));
    expect(screen.getByTestId('setup-bypass-warning')).toBeTruthy();
  });
});
