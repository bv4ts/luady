import { screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { AddCard } from '../../../../src/features/agency/drawers/board/AddCard.js';
import { BoardCard } from '../../../../src/features/agency/drawers/board/BoardCard.js';
import { FleetModal } from '../../../../src/features/agency/drawers/fleet/FleetModal.js';
import { LibraryModal } from '../../../../src/features/agency/drawers/library/LibraryModal.js';
import { LinksModal } from '../../../../src/features/agency/drawers/links/LinksModal.js';
import { TimelineModal } from '../../../../src/features/agency/drawers/timeline/TimelineModal.js';
import { WinsModal } from '../../../../src/features/agency/drawers/wins/WinsModal.js';
import { JiraModal } from '../../../../src/features/agency/drawers/jira/JiraModal.js';
import { GiveProvider } from '../../../../src/features/agency/give/GiveContext.js';
import { ActivityModal } from '../../../../src/features/agency/hud/ActivityModal.js';
import { overview, server, session } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';
import { roomDto } from '../../../room-fixtures.js';
import { card } from '../board/board-fixtures.js';
import { QUIET_STORE, project } from './library-jira-fixtures.js';
import { iso, link, win } from './wave2-fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * Every drawer names and colours offices from the rooms. A room that no fixed table lists
 * (`mars`, on host `mars`) reads as its name everywhere: never "undefined" and never its bare id.
 */
const MARS = roomDto({ id: 'mars', name: 'Mars', short: 'Mars', host: 'mars', position: 0 });
const NO_HUB = async (): Promise<never> => { throw new ApiError(404, 'not_found', 'x'); };

async function open(ui: ReactElement, over: FakeApiOverrides = {}) {
  const api = fakeApi({ ...QUIET_STORE, prefs: NO_HUB, accounts: async () => ({ accounts: [], connections: [] }), ...over });
  const harness = await renderPage(<GiveProvider stage={null} dispatch={vi.fn()}>{ui}</GiveProvider>, {
    api,
    overview: overview({
      rooms: [MARS], servers: [server({ name: 'mars', projectsRoot: '/srv/work' })],
      sessions: [session({ id: 'mars:web:0.0', host: 'mars', displayName: 'web', project: 'web', cwd: '/srv/work/web', state: 'working' })],
      questions: [], actions: [],
    }),
  });
  return harness;
}

const noUndefined = (): void => {
  expect(document.body.textContent).not.toContain('undefined');
};

describe('drawers with a room that is not one of the classic four', () => {
  it('a board card names its office by the room', async () => {
    await open(<BoardCard card={card(1, { server: 'mars' })} lane="todo" live={{ session: undefined, activity: undefined, mission: undefined, question: undefined }} onOpen={vi.fn()} />);
    expect(screen.getByText('Mars')).toBeTruthy();
    noUndefined();
  });

  it('the new-card form offers the room as an office', async () => {
    await open(<AddCard onDone={vi.fn()} />);
    const office = screen.getByLabelText('Office');
    expect(within(office).getByRole('option', { name: 'Mars' })).toBeTruthy();
    expect(within(office).queryByRole('option', { name: 'mars' })).toBeNull();
  });

  it('the links shelf is headed with the room name', async () => {
    await open(<LinksModal room="mars" onClose={vi.fn()} />, { links: async () => ({ items: [link(1, 'mars', 0)] }) });
    expect(await screen.findByRole('heading', { name: 'Mars links' })).toBeTruthy();
    noUndefined();
  });

  it('the wins wall counts the room and names it on a photo', async () => {
    await open(<WinsModal onClose={vi.fn()} />, {
      wins: async () => ({ items: [win(3, Date.now() - 1, { server: 'mars', project: null })], byServer: { mars: 1 } }),
    });
    expect((await screen.findByRole('list', { name: 'This week per office' })).textContent).toBe('Mars · 1');
    expect(screen.getAllByText(/^Mars/).length).toBeGreaterThan(1);
    noUndefined();
  });

  it('the today strip tags its items with the room', async () => {
    await open(<TimelineModal onClose={vi.fn()} />, {
      timeline: async (day) => ({ day: day ?? '2026-11-15', items: [{ at: iso(Date.now() - 60_000), kind: 'done', label: 'Fix totals', server: 'mars', ref: null }] }),
    });
    expect((await screen.findAllByText('Mars')).length).toBeGreaterThan(0);
    noUndefined();
  });

  it('the library shelves the room\'s projects under its name, the folder without the host\'s root', async () => {
    await open(<LibraryModal onClose={vi.fn()} />, {
      library: async () => ({
        offices: [{ server: 'mars', projects: [project({ server: 'mars', name: 'web', path: '/srv/work/web' })], skills: [], skillsAt: null }],
        managerSkills: [],
      }),
    });
    const office = await screen.findByRole('region', { name: 'Mars' });
    expect(within(office).getByText('web · main', { selector: '.lib-project__folder' })).toBeTruthy();
    noUndefined();
  });

  it('the fleet wall names the server by its room', async () => {
    await open(<FleetModal onClose={vi.fn()} />, { fleetHistory: NO_HUB });
    const servers = await screen.findByRole('region', { name: 'Servers' });
    expect(within(servers).getByText('Mars')).toBeTruthy();
    noUndefined();
  });

  it('the activity list puts the working session in the room', async () => {
    await open(<ActivityModal onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^web in Mars/ })).toBeTruthy();
    noUndefined();
  });

  it('a Jira pop-up for the room is headed with its name; without rooms it asks for one first', async () => {
    await open(<JiraModal room="mars" onClose={vi.fn()} />, { jiraSites: async () => ({ sites: [] }) });
    expect(screen.getByText('Mars', { selector: '.jira__office' })).toBeTruthy();
  });
});

describe('drawers in an empty office', () => {
  it('the links shelf and the Jira pop-up say to add a room first', async () => {
    const api = fakeApi({ ...QUIET_STORE, prefs: NO_HUB, links: async () => ({ items: [] }), jiraSites: async () => ({ sites: [] }) });
    await renderPage(<GiveProvider stage={null}><LinksModal room="lot-0" onClose={vi.fn()} /><JiraModal room="lot-0" onClose={vi.fn()} /></GiveProvider>, {
      api, overview: overview({ rooms: [], sessions: [], questions: [], actions: [] }),
    });
    expect(screen.getByText(/Add a room first\. Each room keeps its own shelf/)).toBeTruthy();
    expect(screen.getByText(/Add a room first\. Each room can connect/)).toBeTruthy();
  });
});
