import { describe, expect, it } from 'vitest';
import { homeFolderOf, homeOf, projectsFolderOf } from '../../src/fleet/folders.js';

describe('a host\'s own folders (no fixed path)', () => {
  it('the usual home of a user: /root for root, /home/<user> for anyone else', () => {
    expect(homeOf('root')).toBe('/root');
    expect(homeOf('mars')).toBe('/home/mars');
  });

  it('the projects folder is the row\'s, else projects in the row\'s home, else in the user\'s usual home', () => {
    expect(projectsFolderOf({ projectsRoot: '/srv/work', homeDir: '/home/mars', user: 'mars' })).toBe('/srv/work');
    expect(projectsFolderOf({ projectsRoot: null, homeDir: '/data/mars', user: 'mars' })).toBe('/data/mars/projects');
    expect(projectsFolderOf({ projectsRoot: null, homeDir: null, user: 'mars' })).toBe('/home/mars/projects');
    expect(projectsFolderOf({ projectsRoot: null, homeDir: null, user: 'root' })).toBe('/root/projects');
  });

  it('the home folder is the row\'s, else the user\'s usual one', () => {
    expect(homeFolderOf({ homeDir: '/data/mars', user: 'mars' })).toBe('/data/mars');
    expect(homeFolderOf({ homeDir: null, user: 'ash' })).toBe('/home/ash');
  });
});
