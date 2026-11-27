import { describe, expect, it } from 'vitest';
import {
  changedLine, filterSkills, groupSkills, officeName, parseTags, projectCounts, projectSessions, shelvesOf, shortFolder, sortOffices, spineHeight,
  syncLines,
} from '../../../../src/features/agency/drawers/library/library-model.js';
import { roomLookup } from '../../../../src/features/rooms/room-lookup.js';
import { session } from '../../../fixtures.js';
import { classicRoomDtos, roomDto } from '../../../room-fixtures.js';
import { AT, PAGES, library, project, skill } from './library-jira-fixtures.js';

const NOW = new Date(AT);
const LOOKUP = roomLookup(classicRoomDtos());

describe('library model', () => {
  it('orders offices Orchard, Harbor, Meadow, Private and sorts their projects', () => {
    const offices = sortOffices([...library().offices, { server: 'local', projects: [], skills: [], skillsAt: null }, { server: 'ash', projects: [], skills: [], skillsAt: null }], LOOKUP);
    expect(offices.map((office) => office.server)).toEqual(['birch', 'ash', 'cedar', 'local']);
    expect(offices[0]?.projects.map((p) => p.name)).toEqual(['orchard-api', 'orchard-web']);
  });

  it('orders any number of offices by their room, hosts without a room after them by id, named by their room', () => {
    const lookup = roomLookup([roomDto({ id: 'mars', name: 'Mars', host: 'red-box', position: 1 }), roomDto({ id: 'venus', name: 'Venus', host: 'blue-box', position: 0 })]);
    const office = (server: string) => ({ server, projects: [], skills: [], skillsAt: null });
    expect(sortOffices([office('zeta'), office('red-box'), office('alpha'), office('blue-box')], lookup).map((o) => o.server))
      .toEqual(['blue-box', 'red-box', 'alpha', 'zeta']);
    expect(officeName('red-box', lookup)).toBe('Mars');
    expect(officeName('zeta', lookup)).toBe('zeta');
  });

  it('counts a project in words and leaves out what is zero', () => {
    expect(projectCounts(project())).toBe('2 sessions now · 3 open cards · 1 page');
    expect(projectCounts(project({ sessions: 1, openItems: 0, pages: 4 }))).toBe('1 session now · 4 pages');
    expect(projectCounts(project({ sessions: 0, openItems: 0, pages: 0 }))).toBe('Quiet');
    expect(shortFolder('/home/dev/projects/orchard-web', '/home/dev/projects')).toBe('orchard-web');
    expect(shortFolder('/srv/work/orchard-web', '/srv/work/')).toBe('orchard-web');
    expect(shortFolder('/elsewhere/orchard-web', '/srv/work')).toBe('/elsewhere/orchard-web');
    expect(shortFolder('/srv/work/orchard-web', null)).toBe('/srv/work/orchard-web');
  });

  it('finds the live sessions of a project by folder or project name on the same server', () => {
    const sessions = [
      session({ id: 'birch:a:0.0', host: 'birch', cwd: '/home/dev/projects/orchard-web', project: null }),
      session({ id: 'birch:b:0.0', host: 'birch', cwd: '/elsewhere', project: 'orchard-web' }),
      session({ id: 'birch:c:0.0', host: 'birch', cwd: '/home/dev/projects/orchard-web', state: 'ended' }),
      session({ id: 'cedar:d:0.0', host: 'cedar', cwd: '/home/dev/projects/orchard-web' }),
    ];
    expect(projectSessions(sessions, project()).map((s) => s.id)).toEqual(['birch:a:0.0', 'birch:b:0.0']);
  });

  it('puts pages on shelves: Everyone, then each office before its projects, pinned first', () => {
    const shelves = shelvesOf(PAGES, LOOKUP);
    expect(shelves.map((shelf) => shelf.label)).toEqual(['Everyone', 'Orchard', 'Orchard · orchard-web', 'Meadow']);
    expect(shelves[0]?.pages.map((p) => p.title)).toEqual(['Arabic copy', 'House rules']);
  });

  it('says who changed a page and when, and when each office got its copy', () => {
    expect(changedLine({ updatedBy: 'manager', updatedAt: AT }, NOW)).toMatch(/^Changed by Luady, \d{1,2}:\d{2} [AP]M$/);
    expect(changedLine({ updatedBy: 'system', updatedAt: AT }, NOW)).toMatch(/^Built automatically, /);
    expect(changedLine({ updatedBy: 'owner', updatedAt: 'bad' }, NOW)).toBe('Changed by you');
    expect(syncLines({ cedar: null, birch: AT }, NOW, LOOKUP)).toEqual([{ server: 'birch', text: expect.stringMatching(/[AP]M$/) }, { server: 'cedar', text: 'not yet' }]);
  });

  it('groups and filters skills, and parses tags', () => {
    const skills = [skill({ name: 'z' }), skill({ name: 'a' }), skill({ name: 'p', source: 'plugin', description: 'Pixel art' })];
    expect(groupSkills(skills).map((group) => [group.label, group.skills.map((s) => s.name)])).toEqual([['Yours', ['a', 'z']], ['From plug-ins', ['p']]]);
    expect(filterSkills(skills, 'PIXEL').map((s) => s.name)).toEqual(['p']);
    expect(filterSkills(skills, '  ')).toHaveLength(3);
    expect(parseTags(' a, b c ,,a ')).toEqual(['a', 'b c']);
    expect(spineHeight(10)).toBe(132);
    expect(spineHeight(60_000)).toBeLessThanOrEqual(176);
  });
});
