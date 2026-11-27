import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { NewSessionPage } from '../../../src/features/sessions/NewSessionPage.js';
import { SessionsPage } from '../../../src/features/sessions/SessionsPage.js';
import { action, overview, project, server, session } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { roomDto } from '../../room-fixtures.js';

describe('SessionsPage', () => {
  it('groups sessions by host and highlights the ones that need the owner', async () => {
    const sessions = [
      session({ id: 'cedar:cc-meadow-share:0.0', displayName: 'meadow-share', cwd: '/home/dev/projects/meadow-share', state: 'working' }),
      session({ state: 'waiting_question', pendingQid: 'ABCDEFGH' }),
      session({ id: 'ash:cc-harbor:0.0', host: 'ash', displayName: 'harbor', cwd: '/home/dev/projects/harbor', origin: 'manager' }),
    ];
    await renderPage(<SessionsPage />, { overview: overview({ sessions, servers: [server(), server({ name: 'ash', host: '192.0.2.11' })] }) });
    const cedar = screen.getByRole('region', { name: 'cedar' });
    expect(within(cedar).getAllByRole('link').map((row) => row.textContent?.includes('meadow-hr'))).toEqual([true, false]);
    const urgent = within(cedar).getByRole('link', { name: /meadow-hr/ });
    expect(urgent.className).toContain('session-row--urgent');
    expect(within(urgent).getByText('Needs you')).toBeTruthy();
    expect(urgent.getAttribute('href')).toBe('/sessions/cedar%3Acc-meadow-hr%3A0.0');
    const ash = screen.getByRole('region', { name: 'ash' });
    expect(within(ash).getByText('harbor')).toBeTruthy();
    expect(within(ash).getByText('mission')).toBeTruthy();
    expect(screen.getByText('3 active · 1 needs you')).toBeTruthy();
    const links = screen.getAllByTestId('session-link');
    expect(links.map((link) => link.getAttribute('data-session-id')).sort())
      .toEqual(['ash:cc-harbor:0.0', 'cedar:cc-meadow-hr:0.0', 'cedar:cc-meadow-share:0.0']);
    expect(links.find((link) => link.getAttribute('data-session-id') === 'cedar:cc-meadow-hr:0.0')).toBe(urgent);
  });

  it('names each host by its room, in the office order', async () => {
    const sessions = [
      session({ id: 'mars:cc-a:0.0', host: 'mars', displayName: 'a' }),
      session({ id: 'venus:cc-b:0.0', host: 'venus', displayName: 'b' }),
    ];
    const rooms = [roomDto({ id: 'red', name: 'Red planet', host: 'mars', position: 4 }), roomDto({ id: 'hot', name: 'Hot planet', host: 'venus', position: 1 })];
    await renderPage(<SessionsPage />, { overview: overview({ sessions, servers: [server({ name: 'mars' }), server({ name: 'venus' })], rooms }) });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Hot planet', 'Red planet']);
    expect(within(screen.getByRole('region', { name: 'Red planet' })).getByText('a')).toBeTruthy();
  });

  it('hides ended sessions until asked', async () => {
    const sessions = [session(), session({ id: 'birch:cc-old:0.0', host: 'birch', displayName: 'old-birch', state: 'ended' })];
    const { user } = await renderPage(<SessionsPage />, { overview: overview({ sessions }) });
    expect(screen.queryByText('old-birch')).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Show ended sessions (1)' }));
    expect(screen.getByText('old-birch')).toBeTruthy();
  });

  it('applies live session updates', async () => {
    const { ws } = await renderPage(<SessionsPage />, { overview: overview() });
    expect(screen.getByText('Idle')).toBeTruthy();
    ws.emit({ type: 'session.updated', session: session({ state: 'working' }) });
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('invites the owner to start a session when none run', async () => {
    await renderPage(<SessionsPage />, { overview: overview({ sessions: [] }) });
    expect(screen.getByText('No running sessions')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /New session/ }).length).toBeGreaterThan(0);
  });
});

describe('NewSessionPage', () => {
  it('starts a session in a picked project', async () => {
    const api = fakeApi({
      projects: async () => [project(), project({ path: '/home/dev/projects/meadow-vat', name: 'meadow-vat', branch: 'develop' })],
      createSession: async () => action({ kind: 'session.start', tier: 0, status: 'done', actor: 'owner', channel: 'web' }),
    });
    const { user } = await renderPage(<NewSessionPage />, { api, route: '/sessions/new', path: '/sessions/new' });
    await waitFor(() => expect(api.projects).toHaveBeenCalledWith('cedar'));
    await screen.findByRole('option', { name: 'meadow-vat (develop)' });
    await user.selectOptions(screen.getByLabelText('Project'), '/home/dev/projects/meadow-vat');
    expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('/home/dev/projects/meadow-vat');
    await user.type(screen.getByLabelText('Session name (optional)'), 'vat-fix');
    await user.type(screen.getByLabelText('First prompt (optional)'), 'Fix the VAT rounding bug');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(api.createSession).toHaveBeenCalledWith({
      server: 'cedar', cwd: '/home/dev/projects/meadow-vat', name: 'vat-fix', prompt: 'Fix the VAT rounding bug',
    });
    expect(await screen.findByText('Starting vat-fix on cedar')).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/sessions');
  });

  it('refuses folders outside /home/dev/projects', async () => {
    const api = fakeApi({ projects: async () => [] });
    const { user } = await renderPage(<NewSessionPage />, {
      api, route: '/sessions/new', path: '/sessions/new', overview: overview({ servers: [server({ projectsRoot: '/home/dev/projects' })] }),
    });
    await user.type(screen.getByLabelText('Folder'), '/etc');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(screen.getByText('Pick a folder inside /home/dev/projects.')).toBeTruthy();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it('uses the chosen host\'s own projects folder (/srv/work) for the hint and the check', async () => {
    const api = fakeApi({
      projects: async () => [],
      createSession: async () => action({ kind: 'session.start', tier: 0, status: 'done', actor: 'owner', channel: 'web' }),
    });
    const mars = server({ name: 'mars', projectsRoot: '/srv/work' });
    const { user } = await renderPage(<NewSessionPage />, {
      api, route: '/sessions/new', path: '/sessions/new', overview: overview({ servers: [mars], sessions: [] }),
    });
    expect(screen.getByText('Must be inside /srv/work.')).toBeTruthy();
    expect(screen.getByText('Git repositories under /srv/work.')).toBeTruthy();
    expect((screen.getByLabelText('Folder') as HTMLInputElement).placeholder).toBe('/srv/work/my-project');
    await user.type(screen.getByLabelText('Folder'), '/home/dev/projects/api');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(screen.getByText('Pick a folder inside /srv/work.')).toBeTruthy();
    expect(api.createSession).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText('Folder'));
    await user.type(screen.getByLabelText('Folder'), '/srv/work/api');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(api.createSession).toHaveBeenCalledWith({ server: 'mars', cwd: '/srv/work/api' });
  });

  it('names a host by its room in the server picker and the toast', async () => {
    const api = fakeApi({
      projects: async () => [],
      createSession: async () => action({ kind: 'session.start', tier: 0, status: 'done', actor: 'owner', channel: 'web' }),
    });
    const { user } = await renderPage(<NewSessionPage />, {
      api, route: '/sessions/new', path: '/sessions/new',
      overview: overview({ servers: [server({ name: 'mars' })], sessions: [], rooms: [roomDto({ id: 'mars', name: 'Mars', host: 'mars' })] }),
    });
    expect(screen.getByRole('option', { name: 'Mars · online' })).toBeTruthy();
    await user.type(screen.getByLabelText('Folder'), '/srv/work/api');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByText('Starting api on Mars')).toBeTruthy();
  });

  it('shows the hub error when the session cannot start', async () => {
    const api = fakeApi({
      projects: async () => [project()],
      createSession: async () => { throw new ApiError(409, 'refused', 'tmux session cc-meadow-hr already exists'); },
    });
    const { user } = await renderPage(<NewSessionPage />, { api, route: '/sessions/new', path: '/sessions/new' });
    await user.type(screen.getByLabelText('Folder'), '/home/dev/projects/meadow-hr');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByText('tmux session cc-meadow-hr already exists')).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/sessions/new');
  });
});
