import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SELF_HOST_ID, LOCAL_HOST_ID } from '@luady/shared';
import {
  checkAddress, checkIdFree, checkLocalFree, checkLocalUpdate, ensureLocalFolder, parseCreateBody, parseLocalBody, parseUpdateBody,
  type FolderFs,
} from '../../src/hosts/validate.js';

const PIN = '123456';
const good = { id: 'mars', host: 'mars.example.com', user: 'dev', port: 22, pin: PIN };

function refused(over: Record<string, unknown>): unknown {
  try {
    parseCreateBody({ ...good, ...over });
    return null;
  } catch (err) {
    return err;
  }
}

/** An in-memory folder tree for the local folder rules. */
function fakeFs(dirs: string[], files: string[] = [], links: Record<string, string> = {}): FolderFs & { made: Array<[string, number]> } {
  const made: Array<[string, number]> = [];
  const known = new Set(dirs);
  return {
    made,
    kind: (path) => (known.has(path) ? 'dir' : files.includes(path) ? 'file' : null),
    realpath: (path) => links[path] ?? path,
    mkdir(path, mode) {
      made.push([path, mode]);
      known.add(path);
    },
  };
}

describe('hostile inputs are refused', () => {
  it.each([
    ['host', 'a;rm -rf /'], ['host', '$(id)'], ['host', '`id`'], ['host', 'mars\nexample.com'], ['host', '-oProxyCommand=x'],
    ['host', '..'], ['host', 'a..b'], ['host', '169.254.169.254'], ['host', '0.0.0.0'], ['host', '::'], ['host', '2852039166'],
    ['host', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`], ['port', 0], ['port', 65536], ['user', 'Root'],
    ['user', 'dev;id'], ['projectsRoot', '/srv/../etc'], ['projectsRoot', 'srv/work'], ['id', 'Mars'], ['id', 'a:b'],
  ])('%s = %j', (field, value) => {
    expect(refused({ [field]: value })).toBeInstanceOf(Error);
  });

  it('a 254-character host is refused; 253 is the limit', () => {
    const at253 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(at253).toHaveLength(253);
    expect(refused({ host: at253 })).toBeNull();
    expect(refused({ host: `${at253}e` })).toBeInstanceOf(Error);
  });

  it('accepts ordinary names, documentation addresses and IPv6', () => {
    for (const host of ['mars.example.com', 'ash', '192.0.2.10', '2001:db8::5', 'birch-01.example.com']) {
      expect(refused({ host }), host).toBeNull();
    }
    expect(checkAddress('198.51.100.7')).toBe('198.51.100.7');
  });

  it('hq and computer are never SSH ids; a tombstoned id is never reused', () => {
    expect(refused({ id: SELF_HOST_ID })).toBeInstanceOf(Error);
    expect(refused({ id: LOCAL_HOST_ID })).toBeInstanceOf(Error);
    expect(refused({ id: 'lot-1' })).toBeInstanceOf(Error);
    expect(() => checkIdFree('mars', { state: 'removed' })).toThrow(expect.objectContaining({ code: 'host_exists' }));
    expect(() => checkIdFree('mars', { state: 'pinned' })).toThrow(expect.objectContaining({ code: 'host_exists' }));
    expect(() => checkIdFree('mars', undefined)).not.toThrow();
  });

  it('the update and local bodies are strict too', () => {
    expect(() => parseUpdateBody({ host: '169.254.0.1', pin: PIN })).toThrow(expect.objectContaining({ code: 'address_refused' }));
    expect(() => parseUpdateBody({ pin: PIN, extra: 1 })).toThrow();
    expect(() => parseLocalBody({ projectsRoot: '/home/me/projects', pin: PIN, id: 'x' }, '/home/me')).toThrow();
    expect(parseLocalBody({ projectsRoot: '~/projects', pin: PIN }, '/home/me').projectsRoot).toBe('/home/me/projects');
    expect(parseLocalBody({ projectsRoot: '~', pin: PIN }, '/home/me/').projectsRoot).toBe('/home/me');
    expect(() => parseLocalBody({ projectsRoot: '~other/x', pin: PIN }, '/home/me')).toThrow();
    // A folder the hub cannot use is refused for what it is, never as a bad name, address, user or port.
    expect(() => parseLocalBody({ projectsRoot: 'projects', pin: PIN }, '/home/me')).toThrow(expect.objectContaining({ code: 'folder_invalid' }));
    expect(() => parseLocalBody({ projectsRoot: '/home/me/my projects', pin: PIN }, '/home/me')).toThrow(expect.objectContaining({ code: 'folder_invalid' }));
    expect(() => parseLocalBody({ projectsRoot: '~/projects', pin: PIN }, 'C:\\Users\\me')).toThrow(expect.objectContaining({ code: 'folder_invalid' }));
    expect(parseLocalBody({ projectsRoot: '/home/me/projects', createFolder: true, pin: PIN }, '/home/me')).toMatchObject({ createFolder: true });
    expect(() => checkLocalUpdate({ host: 'mars', pin: PIN })).toThrow(expect.objectContaining({ code: 'local_fields' }));
    expect(() => checkLocalUpdate({ projectsRoot: '/home/me/work', pin: PIN })).not.toThrow();
  });
});

describe('this computer', () => {
  it('a second local host is refused; a removed one may be made again', () => {
    expect(() => checkLocalFree({ state: 'pinned', source: 'web' })).toThrow(expect.objectContaining({ code: 'local_exists' }));
    expect(() => checkLocalFree({ state: 'pinned', source: 'config' })).toThrow(expect.objectContaining({ code: 'local_exists' }));
    expect(() => checkLocalFree({ state: 'removed', source: 'web' })).not.toThrow();
    expect(() => checkLocalFree(undefined)).not.toThrow();
  });

  it('an existing folder is used as it is, anywhere', () => {
    const disk = fakeFs(['/srv/work']);
    expect(ensureLocalFolder('/srv/work', { createFolder: false, home: '/home/me', disk })).toBe(false);
    expect(disk.made).toEqual([]);
  });

  it('a missing folder needs createFolder, and is made at 0700 inside the home with an existing parent', () => {
    const disk = fakeFs(['/home/me']);
    expect(() => ensureLocalFolder('/home/me/projects', { createFolder: false, home: '/home/me', disk }))
      .toThrow(expect.objectContaining({ code: 'folder_missing' }));
    expect(ensureLocalFolder('/home/me/projects', { createFolder: true, home: '/home/me', disk })).toBe(true);
    expect(disk.made).toEqual([['/home/me/projects', 0o700]]);
  });

  it('a new projects folder outside the home, under a missing parent, over a file or through a symlinked escape is refused', () => {
    const disk = fakeFs(['/home/me', '/home/me/link'], ['/home/me/notes'], { '/home/me/link': '/etc' });
    const make = (path: string) => () => ensureLocalFolder(path, { createFolder: true, home: '/home/me', disk });
    expect(make('/srv/projects')).toThrow(expect.objectContaining({ code: 'folder_outside_home' }));
    expect(make('/home/me')()).toBe(false);
    expect(make('/home/me/a/b')).toThrow(expect.objectContaining({ code: 'folder_parent_missing' }));
    expect(make('/home/me/notes')).toThrow(expect.objectContaining({ code: 'not_a_folder' }));
    expect(make('/home/me/link/projects')).toThrow(expect.objectContaining({ code: 'folder_outside_home' }));
    expect(disk.made).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('on a real disk the new folder is 0700', () => {
    const home = mkdtempSync(join(tmpdir(), 'luady-home-'));
    mkdirSync(join(home, 'sub'));
    writeFileSync(join(home, 'file'), '');
    expect(ensureLocalFolder(join(home, 'sub', 'projects'), { createFolder: true, home })).toBe(true);
    expect(statSync(join(home, 'sub', 'projects')).mode & 0o777).toBe(0o700);
  });
});
