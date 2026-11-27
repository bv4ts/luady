import { describe, expect, it } from 'vitest';
import { globMayHitDenied, isRecursionSafe, referencesDeniedPath, toAbsolute } from '../../src/security/risk-paths.js';

const DENIED = [
  '~/.ssh/id_ed25519',
  '/home/dev/.ssh',
  '.ssh',
  '/home/dev/.claude/.credentials.json',
  '/etc/shadow',
  '/etc/./shadow',
  '/etc//sudoers',
  '/etc/sudoers.d/90-cloud',
  '~/.luady/answers/ABCDEFGH.json',
  '/home/dev/.luady/./answers',
  '--file=/home/dev/.ssh/config',
  '/ETC/SHADOW',
  '/proc/self/root/etc/hosts',
  '/proc/1234/cwd',
  '/proc/self/task/1/cwd/id_ed25519',
  'etc/gshadow',
].map((text) => ({ text }));

const ALLOWED = [
  '/var/log/syslog',
  '/home/dev/projects/app/.env',
  'ssh',
  '/etc/passwd',
  '/proc/loadavg',
  '/home/dev/.luady/pending/X.json',
].map((text) => ({ text }));

const GLOBS: Array<{ word: string; cwd: string | null; hit: boolean }> = [
  { word: '/etc/shado?', cwd: null, hit: true },
  { word: '/e*/shadow', cwd: null, hit: true },
  { word: '/etc/s*', cwd: null, hit: true },
  { word: '~/.ss?/id_ed25519', cwd: null, hit: true },
  { word: '/home/*/.ssh/*', cwd: null, hit: true },
  { word: '/home/dev/.c*/.cred*', cwd: null, hit: true },
  { word: '/home/dev/*', cwd: null, hit: true },
  { word: '*.log', cwd: null, hit: true },
  { word: '/proc/*/status', cwd: null, hit: true },
  { word: '/var/log/*.log', cwd: null, hit: false },
  { word: '/home/dev/projects/*/README.md', cwd: null, hit: false },
  { word: '/etc/*.conf', cwd: null, hit: false },
  { word: '*.log', cwd: '/var/log', hit: false },
  { word: '[c]laude', cwd: '/home/dev', hit: false },
];

const RECURSION: Array<{ word: string; cwd: string | null; safe: boolean }> = [
  { word: '/', cwd: null, safe: false },
  { word: '/home', cwd: null, safe: false },
  { word: '/home/dev', cwd: null, safe: false },
  { word: '~', cwd: null, safe: false },
  { word: '~/.claude', cwd: null, safe: false },
  { word: '/home/dev/.luady', cwd: null, safe: false },
  { word: '/etc', cwd: null, safe: false },
  { word: '/root/.ssh', cwd: null, safe: false },
  { word: '.', cwd: '/home/dev', safe: false },
  { word: '..', cwd: '/home/dev/projects', safe: false },
  { word: '/proc/self/root/home/dev/projects', cwd: null, safe: false },
  { word: 'src', cwd: null, safe: false },
  { word: '~+', cwd: null, safe: false },
  { word: '/home/dev/projects/app', cwd: null, safe: true },
  { word: '/var/log/nginx', cwd: null, safe: true },
  { word: 'src', cwd: '/home/dev/projects/app', safe: true },
  { word: 'TODO', cwd: '/home/dev/projects/app', safe: true },
  { word: '~/projects/app', cwd: null, safe: true },
];

describe('referencesDeniedPath', () => {
  it.for(DENIED)('flags $text', ({ text }) => {
    expect(referencesDeniedPath(text)).toBe(true);
  });

  it.for(ALLOWED)('allows $text', ({ text }) => {
    expect(referencesDeniedPath(text)).toBe(false);
  });
});

describe('globMayHitDenied', () => {
  it.for(GLOBS)('$word in $cwd → $hit', ({ word, cwd, hit }) => {
    expect(globMayHitDenied(word, cwd)).toBe(hit);
  });
});

describe('isRecursionSafe', () => {
  it.for(RECURSION)('$word in $cwd → $safe', ({ word, cwd, safe }) => {
    expect(isRecursionSafe(word, cwd)).toBe(safe);
  });
});

describe('toAbsolute', () => {
  it('resolves words to normalized absolute paths', () => {
    expect(toAbsolute('~', null)).toBe('/home/*');
    expect(toAbsolute('~/x/../y', null)).toBe('/home/*/y');
    expect(toAbsolute('~dev/.ssh', null)).toBe('/home/dev/.ssh');
    expect(toAbsolute('~+/x', '/tmp')).toBeNull();
    expect(toAbsolute('/a//b/./c', null)).toBe('/a/b/c');
    expect(toAbsolute('src', '/home/dev/projects/app')).toBe('/home/dev/projects/app/src');
    expect(toAbsolute('src', null)).toBeNull();
  });
});
