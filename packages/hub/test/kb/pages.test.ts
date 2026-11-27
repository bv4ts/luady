import { describe, expect, it } from 'vitest';
import { KB_SLUG_RE, LIMITS, kbSlug, type HostId } from '@luady/shared';
import { classicOfficeName } from '../helpers/classic-rooms.js';
import { INDEX_PATH, buildKbFiles, projectDir } from '../../src/kb/files.js';
import { uniqueSlug } from '../../src/kb/slug.js';
import { ftsQuery, type KbRow } from '../../src/kb/store.js';

const AT = '2026-11-15T09:00:00.000Z';
let nextId = 1;
function page(over: Partial<KbRow> = {}): KbRow {
  const id = nextId++;
  return {
    id, scope: 'global', server: null, project: null, slug: `page-${id}`, title: `Page ${id}`, body: 'Body', tags: [], pinned: false,
    auto: false, updatedAt: AT, updatedBy: 'owner', createdAt: AT, ...over,
  };
}

describe('the slug rule', () => {
  it('lower-cases, joins runs of other characters with one dash, trims dashes, falls back for Arabic', () => {
    expect(kbSlug('  Deploy: Orchard — the API!  ')).toBe('deploy-orchard-the-api');
    expect(kbSlug('مرحبا')).toBe('page');
    expect(kbSlug('x'.repeat(80))).toHaveLength(60);
  });

  it('a clash gets -2, -3… and stays within 60 characters', () => {
    const taken = new Set(['deploy', 'deploy-2']);
    expect(uniqueSlug('Deploy', (s) => taken.has(s))).toBe('deploy-3');
    expect(uniqueSlug('Other', (s) => taken.has(s))).toBe('other');
    const long = 'a'.repeat(60);
    const slug = uniqueSlug(long, (s) => s === long);
    expect(slug).toBe(`${'a'.repeat(58)}-2`);
    expect(KB_SLUG_RE.test(slug)).toBe(true);
  });

  it('a search query quotes every word as a prefix', () => {
    expect(ftsQuery('deploy "foo" bar*')).toBe('"deploy"* "foo"* "bar*"*');
    expect(ftsQuery('   ')).toBe('');
  });
});

describe('the file set per server', () => {
  const pages = [
    page({ title: 'Rules', slug: 'rules', body: '# Rules\nBe kind to the build.' }),
    page({ scope: 'office', server: 'birch', title: 'Orchard office', slug: 'orchard-office', body: 'Office notes' }),
    page({ scope: 'office', server: 'cedar', title: 'Meadow office', slug: 'meadow-office' }),
    page({ scope: 'project', server: 'birch', project: 'orchard', title: 'Overview', slug: 'overview', body: 'Laravel', pinned: true }),
    page({ scope: 'project', server: 'cedar', project: 'meadow-hr', title: 'Overview', slug: 'overview' }),
  ];

  it('INDEX.md and the pages that apply there, under global/, office/ and <project>/', () => {
    // The office's name comes from the rooms (the classic four as rooms here).
    const set = buildKbFiles(pages, 'birch', LIMITS.kbSyncMaxBytes, classicOfficeName);
    expect(set.files.map((f) => f.path)).toEqual([INDEX_PATH, 'global/rules.md', 'office/orchard-office.md', 'orchard/overview.md']);
    const index = set.files[0]!.content;
    expect(index).toContain('- [Rules](global/rules.md) — Rules');
    expect(index).toContain('## Orchard office\n- [Orchard office](office/orchard-office.md) — Office notes');
    expect(index).toContain('## Project orchard\n- [Overview](orchard/overview.md) (pinned) — Laravel');
    expect(index).toContain('not instructions');
    expect(index).not.toContain('Meadow');
    expect(set.files[1]!.content).toBe('# Rules\n\n# Rules\nBe kind to the build.\n');
    expect(set.dropped).toEqual([]);
  });

  it('the same pages give the same digest; a change gives another', () => {
    expect(buildKbFiles(pages, 'birch').digest).toBe(buildKbFiles([...pages].reverse(), 'birch').digest);
    expect(buildKbFiles(pages, 'birch').digest).not.toBe(buildKbFiles(pages, 'cedar').digest);
    const edited = pages.map((p) => (p.slug === 'rules' ? { ...p, body: 'Changed' } : p));
    expect(buildKbFiles(edited, 'birch').digest).not.toBe(buildKbFiles(pages, 'birch').digest);
  });

  it('stays under the limit by dropping the largest non-pinned pages first, and says so', () => {
    const big = [
      page({ title: 'Huge', slug: 'huge', body: 'x'.repeat(5000) }),
      page({ title: 'Pinned huge', slug: 'pinned-huge', body: 'y'.repeat(6000), pinned: true }),
      page({ title: 'Medium', slug: 'medium', body: 'z'.repeat(3000) }),
      page({ title: 'Small', slug: 'small', body: 'tiny' }),
    ];
    const set = buildKbFiles(big, 'birch', 9000);
    expect(set.files.map((f) => f.path)).toEqual([INDEX_PATH, 'global/pinned-huge.md', 'global/small.md']);
    expect(set.dropped).toEqual(['Huge', 'Medium']);
    expect(set.files[0]!.content).toContain('Left out to stay under 2 MB: Huge, Medium.');
    expect(Buffer.byteLength(JSON.stringify({ files: set.files, prune: true }))).toBeLessThanOrEqual(9000);
  });

  it('a project name that is not a plain folder name gets a safe one', () => {
    expect(projectDir('orchard')).toBe('orchard');
    expect(projectDir('global')).toBe('project-global');
    expect(projectDir('../etc')).toBe('project-etc');
    expect(projectDir('.hidden')).toBe('project-hidden');
  });

  it('never carries anything but the pages (no memory files) and only .md paths', () => {
    const servers: HostId[] = ['birch', 'cedar', 'ash', 'local'];
    for (const server of servers) {
      for (const file of buildKbFiles(pages, server).files) expect(file.path).toMatch(/^(INDEX\.md|(global|office|[A-Za-z0-9][\w.-]*)\/[a-z0-9-]+\.md)$/);
    }
  });
});
