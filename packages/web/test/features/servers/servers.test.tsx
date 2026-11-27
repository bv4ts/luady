import type { ServerDTO } from '@luady/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { ServerDetailPage } from '../../../src/features/servers/ServerDetailPage.js';
import { ServersPage } from '../../../src/features/servers/ServersPage.js';
import { action, fileRead, overview, project, server } from '../../fixtures.js';
import { fakeApi, type FakeApi, type FakeApiOverrides } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';
import { roomDto } from '../../room-fixtures.js';

const detailApi = (over: FakeApiOverrides = {}): FakeApi => fakeApi({ projects: async () => [], ...over });
/** cedar, with the home folder the hub reports for it. */
const openDetail = (api: FakeApi, over: Partial<ServerDTO> = { homeDir: '/home/dev' }) =>
  renderPage(<ServerDetailPage />, { api, route: '/servers/cedar', path: '/servers/:name', overview: overview({ servers: [server(over)] }) });
const done = (result: string, kind = 'server.exec') => action({ kind, status: 'done', actor: 'owner', channel: 'web', result });

describe('ServersPage', () => {
  it('shows health, versions and projects for each server', async () => {
    const ash = server({
      name: 'ash', host: '192.0.2.11', claudeVersion: '2.1.290',
      sysinfo: { load1: 1.5, load5: 1.2, mem_total_kb: 8_000_000, mem_avail_kb: 600_000, disk_free_kb: 5_976_883, uptime_s: 90_061 },
    });
    const api = fakeApi({
      projects: async (name) => (name === 'cedar'
        ? [project()]
        : [project({ server: 'ash', path: '/home/dev/projects/harbor', name: 'harbor', stack: ['flutter'] })]),
    });
    await renderPage(<ServersPage />, { api, overview: overview({ servers: [server(), ash] }) });
    const card = screen.getByRole('article', { name: 'Server ash' });
    expect(within(card).getByText('2.1.290')).toBeTruthy();
    expect(within(card).getByText('Low disk space')).toBeTruthy();
    expect(within(card).getByText('5.7 GB')).toBeTruthy();
    expect(await within(card).findByText('harbor')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Server cedar' })).getByText('2.1.295')).toBeTruthy();
    expect(api.projects).toHaveBeenCalledWith('cedar');
    expect(api.projects).toHaveBeenCalledWith('ash');
  });
});

describe('ServerDetailPage', () => {
  it('run command: 428 opens the PIN modal and retries with the PIN', async () => {
    const api = detailApi({
      exec: async (_server, body) => {
        if (!body.pin) throw new ApiError(428, 'pin_required', 'This command needs your PIN');
        return done('nginx restarted');
      },
    });
    const { user } = await openDetail(api);
    await user.type(screen.getByLabelText('Command'), 'systemctl restart nginx');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run on cedar' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('nginx restarted')).toBeTruthy();
    expect(api.exec.mock.calls.map((call) => call[1])).toEqual([
      { command: 'systemctl restart nginx' },
      { command: 'systemctl restart nginx', pin: '123456' },
    ]);
  });

  it('run command: read-only commands run without a PIN', async () => {
    const api = detailApi({ exec: async () => done('Filesystem Size Used Avail') });
    const { user } = await openDetail(api);
    await user.type(screen.getByLabelText('Command'), 'df -h');
    await user.type(screen.getByLabelText('Working folder (optional)'), '/home/dev/projects');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Filesystem Size Used Avail')).toBeTruthy();
    expect(api.exec).toHaveBeenCalledWith('cedar', { command: 'df -h', cwd: '/home/dev/projects' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('file editor: opens, edits and saves with the PIN', async () => {
    const api = detailApi({ readFile: async () => fileRead(), writeFile: async () => done('wrote 18 bytes', 'server.file_write') });
    const { user } = await openDetail(api);
    await user.click(screen.getByRole('button', { name: 'settings.json' }));
    const editor = await screen.findByLabelText('Contents of settings.json');
    await user.clear(editor);
    await user.paste('{"model":"sonnet"}');
    await user.click(screen.getByRole('button', { name: 'Save with PIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save settings.json on cedar' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.writeFile).toHaveBeenCalledWith('cedar', {
      path: '/home/dev/.claude/settings.json', content: '{"model":"sonnet"}', pin: '123456',
    }));
    expect(await screen.findByText('#A7 done: wrote 18 bytes')).toBeTruthy();
  });

  it('file editor: blocks invalid JSON before asking for the PIN', async () => {
    const api = detailApi({ readFile: async () => fileRead() });
    const { user } = await openDetail(api);
    await user.click(screen.getByRole('button', { name: 'settings.json' }));
    const editor = await screen.findByLabelText('Contents of settings.json');
    await user.clear(editor);
    await user.paste('{"model": ');
    await user.click(screen.getByRole('button', { name: 'Save with PIN' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid JSON/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('file editor: truncated files are read-only', async () => {
    const api = detailApi({
      readFile: async () => fileRead({ path: '/home/dev/projects/meadow-hr/storage/logs/laravel.log', truncated: true, content: 'line 1' }),
    });
    const { user } = await openDetail(api);
    await user.clear(screen.getByLabelText('Path'));
    await user.type(screen.getByLabelText('Path'), '/home/dev/projects/meadow-hr/storage/logs/laravel.log');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/editing is off/)).toBeTruthy();
    expect((screen.getByLabelText('Contents of laravel.log') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByRole('button', { name: 'Save with PIN' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('updates Claude Code with the PIN', async () => {
    const api = detailApi({ updateClaude: async () => done('2.1.295 -> 2.1.300', 'server.claude_update') });
    const { user } = await openDetail(api);
    await user.click(screen.getByRole('button', { name: 'Update Claude Code' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update Claude Code on cedar' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.updateClaude).toHaveBeenCalledWith('cedar', { pin: '123456' }));
    expect(await screen.findByText('2.1.295 -> 2.1.300')).toBeTruthy();
  });

  it('lists skills read-only and validates package names before installing', async () => {
    const api = detailApi({ exec: async () => done('graphify\nsuperpowers') });
    const { user } = await openDetail(api);
    await user.click(screen.getByRole('button', { name: 'List skills' }));
    expect(api.exec).toHaveBeenCalledWith('cedar', { command: 'ls -1 /home/dev/.claude/skills' });
    await user.type(screen.getByLabelText('Install a skill'), 'bad; rm -rf /');
    await user.click(screen.getByRole('button', { name: 'Install' }));
    expect(screen.getByText('Use a package name like owner/repo or @scope/skill.')).toBeTruthy();
    expect(api.exec).toHaveBeenCalledTimes(1);
  });

  it('says when the server does not exist', async () => {
    await renderPage(<ServerDetailPage />, { api: detailApi(), route: '/servers/vps', path: '/servers/:name' });
    expect(screen.getByText('Server not found')).toBeTruthy();
  });

  it('takes the quick files, the skills folder and the working-folder hint from the host\'s home folder', async () => {
    const api = detailApi({ readFile: async () => fileRead({ path: '/home/ops/.claude/settings.json' }), exec: async () => done('none') });
    const { user } = await openDetail(api, { homeDir: '/home/ops' });
    expect((screen.getByLabelText('Working folder (optional)') as HTMLInputElement).placeholder).toBe('/home/ops');
    await user.click(screen.getByRole('button', { name: 'settings.json' }));
    await waitFor(() => expect(api.readFile).toHaveBeenCalledWith('cedar', '/home/ops/.claude/settings.json'));
    await user.click(screen.getByRole('button', { name: 'List skills' }));
    expect(api.exec).toHaveBeenCalledWith('cedar', { command: 'ls -1 /home/ops/.claude/skills' });
    expect(screen.getByText('Claude Code skills in /home/ops/.claude/skills.')).toBeTruthy();
  });

  it('without a home folder from the hub: no quick files, and the skills list runs in the shell\'s home', async () => {
    const api = detailApi({ exec: async () => done('none') });
    const { user } = await openDetail(api, { homeDir: null });
    expect(screen.queryByRole('button', { name: 'settings.json' })).toBeNull();
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: 'List skills' }));
    expect(api.exec).toHaveBeenCalledWith('cedar', { command: 'ls -1 ~/.claude/skills' });
  });

  it('offers no terminal for a host without one (this computer)', async () => {
    await openDetail(detailApi(), { homeDir: '/home/dev', terminal: false });
    expect(screen.queryByRole('link', { name: 'Open terminal' })).toBeNull();
  });

  it('names the server by its room', async () => {
    await renderPage(<ServerDetailPage />, {
      api: detailApi(), route: '/servers/cedar', path: '/servers/:name',
      overview: overview({ servers: [server({ homeDir: '/home/dev' })], rooms: [roomDto({ id: 'meadow', name: 'Meadow', host: 'cedar' })] }),
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Meadow');
  });
});

describe('ServersPage order and links', () => {
  it('lists servers in the office order and links a terminal only where there is one', async () => {
    const rooms = [roomDto({ id: 'b', host: 'venus', position: 0 }), roomDto({ id: 'a', host: 'mars', position: 1 })];
    const servers = [server({ name: 'zeta' }), server({ name: 'mars' }), server({ name: 'venus', terminal: false })];
    await renderPage(<ServersPage />, { api: detailApi(), overview: overview({ servers, rooms }) });
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Server venus', 'Server mars', 'Server zeta']);
    expect(within(screen.getByRole('article', { name: 'Server venus' })).queryByRole('link', { name: 'Terminal' })).toBeNull();
    expect(within(screen.getByRole('article', { name: 'Server mars' })).getByRole('link', { name: 'Terminal' })).toBeTruthy();
  });
});
