import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { AddServerFlow } from '../../../src/features/hosts/AddServerFlow.js';
import { overview } from '../../fixtures.js';
import { renderPage } from '../../helpers/render.js';
import { hostDto, roomDto } from '../../room-fixtures.js';
import { FP, KEY_LINE, PIN, enterPin, fakeHostsApi, withHosts, type FakeHostsApi } from './hosts-fixtures.js';

vi.mock('../../../src/features/rooms/creature-preview.js', () => ({ CREATURE_PX: 24, drawCreature: vi.fn(async () => false) }));

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});

async function open(api: FakeHostsApi, props: { resume?: string } = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const h = await renderPage(withHosts(api, <AddServerFlow mode="wizard" onDone={onDone} onCancel={onCancel} {...props} />), {
    overview: overview({ servers: [], rooms: [] }),
  });
  return { h, onDone, onCancel };
}

const step = (id: string): HTMLElement => screen.getByTestId(`host-step-${id}`);

describe('adding a server, step by step', () => {
  it('details with the PIN, the line to paste, the fingerprint with "It matches", the check, the kit and the room', async () => {
    const api = fakeHostsApi();
    const { h, onDone } = await open(api);
    expect(step('details').textContent).toContain('saved as a draft: nothing connects to it yet');

    await h.user.type(screen.getByLabelText('Address'), 'mars.example.com');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('mars');
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    await enterPin(h);
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ id: 'mars', host: 'mars.example.com', user: 'dev', port: 22, pin: PIN }));

    // The key line: one command to paste, which only adds the hub's restricted key.
    const paste = await screen.findByTestId('host-paste-line');
    expect(paste.textContent).toBe(`mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\\n%s\\n' '${KEY_LINE}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`);
    await h.user.click(within(step('key')).getAllByRole('button', { name: 'Copy' })[0] as HTMLElement);
    expect(await screen.findByText('Copied.')).toBeTruthy();
    await h.user.click(screen.getByRole('button', { name: 'I have pasted it' }));

    // The fingerprint: shown with the command to compare it; trusting needs the tick.
    expect(step('verify').textContent).toContain('It does not sign in');
    await h.user.click(screen.getByRole('button', { name: 'Test the connection' }));
    expect((await screen.findByTestId('host-fingerprint')).textContent).toBe(FP);
    expect(screen.getByTestId('host-compare').textContent).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    expect(api.scan).toHaveBeenCalledWith('mars', 'grant-1');
    const trust = screen.getByRole('button', { name: 'Trust this server' }) as HTMLButtonElement;
    expect(trust.disabled).toBe(true);
    await h.user.click(screen.getByLabelText('It matches'));
    expect(trust.disabled).toBe(false);
    await h.user.click(trust);
    await waitFor(() => expect(api.pin).toHaveBeenCalledWith('mars', FP, 'grant-1'));

    // The check: missing items are shown as text.
    api.check.mockResolvedValueOnce({ auth: 'ok', preflight: { ready: 'no' }, missing: ['tmux', 'Claude Code at ~/.local/bin/claude'] });
    await h.user.click(await screen.findByRole('button', { name: 'Check now' }));
    const missing = await screen.findByTestId('host-missing');
    expect(within(missing).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['tmux', 'Claude Code at ~/.local/bin/claude']);
    await h.user.click(screen.getByRole('button', { name: 'Try again' }));
    await h.user.click(await screen.findByRole('button', { name: 'Go on' }));

    // The kit: consent first, then progress lines, then the end.
    expect(step('kit').textContent).toContain('copies a small program to ~/.luady');
    await h.user.click(screen.getByRole('button', { name: 'Install the kit' }));
    expect(api.kit).toHaveBeenCalledWith('mars', 'install', 'grant-1');
    act(() => {
      h.ws.emit({ type: 'host.log', host: 'mars', job: 'job-1', line: 'Sending the kit to mars.', at: '2026-11-21T08:00:00.000Z' });
      h.ws.emit({ type: 'host.log', host: 'mars', job: 'job-1', line: '<b>not markup</b>', at: '2026-11-21T08:00:01.000Z' });
    });
    const log = await screen.findByTestId('host-log');
    expect(within(log).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Sending the kit to mars.', '<b>not markup</b>']);
    expect(log.querySelector('b')).toBeNull();
    act(() => h.ws.emit({ type: 'host.job', host: 'mars', job: 'job-1', state: 'done', summary: 'Kit 2.1.0 is on mars.' }));
    expect(await screen.findByText('Kit 2.1.0 is on mars.')).toBeTruthy();
    api.hosts.splice(0, 1, hostDto({ id: 'mars', kitVersion: '2.1.0' }));
    act(() => h.ws.emit({ type: 'hosts.changed', hosts: [hostDto({ id: 'mars', kitVersion: '2.1.0' })], at: '2026-11-21T08:00:02.000Z' }));
    await h.user.click(screen.getByRole('button', { name: 'Go on' }));

    // The room, with the rooms editor; skipping ends the flow too.
    expect(step('room').textContent).toContain('Give mars a room');
    await h.user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onDone).toHaveBeenCalledWith({ host: 'mars', room: null });
  });

  it('denied: the line is shown again with "Try again", which checks once more', async () => {
    const api = fakeHostsApi([hostDto({ id: 'mars', kitVersion: null, link: 'offline', lastError: 'auth' })]);
    const { h } = await open(api, { resume: 'mars' });
    api.check.mockResolvedValueOnce({ auth: 'denied', preflight: null, missing: [], line: KEY_LINE });
    await h.user.click(await screen.findByRole('button', { name: 'Check now' }));
    await enterPin(h);
    const result = await screen.findByTestId('host-check-result');
    expect(result.textContent).toContain('mars refused the hub\'s key');
    expect(within(result).getByTestId('host-paste-line').textContent).toContain(KEY_LINE);
    await h.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.check).toHaveBeenCalledTimes(2));
    expect(api.grant).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Go on' })).toBeTruthy();
  });

  it('resumes from the hosts list: an unfinished server is offered, and its step is worked out from the host', async () => {
    const api = fakeHostsApi([hostDto({ id: 'mars', state: 'draft', fingerprint: null, link: null, kitVersion: null })]);
    const { h } = await open(api);
    expect(await screen.findByText(/You started adding mars/)).toBeTruthy();
    await h.user.click(screen.getByRole('button', { name: 'Continue with mars' }));
    expect(await screen.findByTestId('host-step-key')).toBeTruthy();
  });

  it('resumes a running kit job from GET /api/hosts/:id/job', async () => {
    const api = fakeHostsApi([hostDto({ id: 'mars', kitVersion: null })]);
    api.job.mockResolvedValue({ job: 'job-7', state: 'running', summary: null, error: null });
    const { h } = await open(api, { resume: 'mars' });
    await h.user.click(await screen.findByRole('button', { name: 'Check now' }));
    await enterPin(h);
    await h.user.click(await screen.findByRole('button', { name: 'Go on' }));
    expect(await screen.findByText('Installing on mars…')).toBeTruthy();
    act(() => h.ws.emit({ type: 'host.job', host: 'mars', job: 'job-7', state: 'failed', error: 'The kit could not be unpacked on the server (tar).' }));
    expect(await screen.findByText('The kit could not be unpacked on the server (tar).')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('keeps a kit job that ended before the page handled its 202 as ended (a fast install is not shown running forever)', async () => {
    const api = fakeHostsApi([hostDto({ id: 'mars', kitVersion: null })]);
    let answer: (job: { job: string; state: 'running'; summary: null; error: null }) => void = () => undefined;
    api.kit.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { h } = await open(api, { resume: 'mars' });
    await h.user.click(await screen.findByRole('button', { name: 'Check now' }));
    await enterPin(h);
    await h.user.click(await screen.findByRole('button', { name: 'Go on' }));
    await h.user.click(screen.getByRole('button', { name: 'Install the kit' }));
    // The hub's own events for the job arrive first, as the hub sends them: its start, its line, then its end.
    act(() => {
      h.ws.emit({ type: 'host.job', host: 'mars', job: 'job-1', state: 'running' });
      h.ws.emit({ type: 'host.log', host: 'mars', job: 'job-1', line: 'Sending the kit to mars.', at: '2026-11-21T08:00:00.000Z' });
      h.ws.emit({ type: 'host.job', host: 'mars', job: 'job-1', state: 'done', summary: 'Kit 2.1.0 is on mars.' });
    });
    // Then the POST's 202 answer for that same job, still saying "running".
    await act(async () => answer({ job: 'job-1', state: 'running', summary: null, error: null }));
    expect(await screen.findByText('Kit 2.1.0 is on mars.')).toBeTruthy();
    expect(screen.queryByText('Installing on mars…')).toBeNull();
    expect(within(screen.getByTestId('host-log')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Sending the kit to mars.']);
    expect(screen.getByRole('button', { name: 'Go on' })).toBeTruthy();
  });

  it('turns refusals into what to do next, never the hub\'s raw text', async () => {
    const api = fakeHostsApi();
    api.create.mockRejectedValueOnce(new ApiError(409, 'host_exists', 'mars is taken (raw hub text)'));
    const { h } = await open(api);
    await h.user.type(screen.getByLabelText('Address'), 'mars.example.com');
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    await enterPin(h);
    expect(await screen.findByText(/Names are never reused: choose another/)).toBeTruthy();
    expect(screen.queryByText(/raw hub text/)).toBeNull();
  });

  it('checks the form before asking for the PIN', async () => {
    const api = fakeHostsApi();
    const { h } = await open(api);
    await h.user.type(screen.getByLabelText('Address'), 'a;rm -rf /');
    await h.user.clear(screen.getByLabelText('User'));
    await h.user.type(screen.getByLabelText('User'), 'Root');
    await h.user.click(screen.getByRole('button', { name: 'Save and go on' }));
    expect(screen.getByText('Enter the server\'s host name or IP address.')).toBeTruthy();
    expect(screen.getByText(/Unix user the hub signs in as, in lower case/)).toBeTruthy();
    expect(screen.queryByLabelText('PIN')).toBeNull();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('a resumed server that is gone says so and offers a new one', async () => {
    const api = fakeHostsApi();
    const { h } = await open(api, { resume: 'venus' });
    expect(await screen.findByText(/venus is not in the list of servers any more/)).toBeTruthy();
    await h.user.click(screen.getByRole('button', { name: 'Add a server' }));
    expect(await screen.findByTestId('host-step-details')).toBeTruthy();
  });

  it('a finished server goes straight to the end; a room already there counts', async () => {
    const api = fakeHostsApi([hostDto({ id: 'mars', kitVersion: '2.1.0' })]);
    const onDone = vi.fn();
    const h = await renderPage(withHosts(api, <AddServerFlow mode="settings" resume="mars" onDone={onDone} onCancel={() => undefined} />), {
      overview: overview({ servers: [], rooms: [roomDto({ id: 'mars', host: 'mars' })] }),
    });
    await h.user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith({ host: 'mars', room: null });
  });
});
