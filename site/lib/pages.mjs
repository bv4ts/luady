/**
 * The docs in reading order, in groups for the side menu. The menu is built from the Markdown files that exist in
 * docs/ when the site is built: a page listed here but not there is left out (it may not have been written yet), and a
 * page there but not listed here goes under "More", so a new page is never left out and never breaks the build. The
 * menu, the page titles and the previous and next links all use each page's own first heading, so a page has one name
 * everywhere.
 *
 * Reading order: the overview, getting started and the setup wizard (one way to install), then the install on a
 * fresh machine step by step for those who want it, then using it, trusting it, and getting help.
 */
export const NAV = [
  { group: 'Start', pages: ['README.md', 'getting-started.md', 'setup-wizard.md', 'quickstart.md'] },
  { group: 'Use', pages: ['rooms.md', 'servers.md', 'configuration.md', 'manager.md', 'addons.md'] },
  { group: 'Trust', pages: ['security.md', 'security-notes.md', 'verifying-releases.md'] },
  { group: 'Help', pages: ['troubleshooting.md', 'faq.md'] },
];
export const OTHER_GROUP = 'More';

/** The menu for the files in docs/: listed pages that exist, in order, then any other page under "More". */
export function navFor(files) {
  const present = new Set(files);
  if (!present.has('README.md')) throw new Error('site: docs/README.md, the docs overview, is missing');
  const listed = new Set(NAV.flatMap(({ pages }) => pages));
  const groups = NAV
    .map(({ group, pages }) => ({ group, pages: pages.filter((file) => present.has(file)).map((file) => ({ file })) }))
    .filter(({ pages }) => pages.length > 0);
  const extra = [...present].filter((file) => !listed.has(file)).sort();
  if (extra.length > 0) groups.push({ group: OTHER_GROUP, pages: extra.map((file) => ({ file })) });
  return groups;
}

/** The pages in menu order, for the "previous" and "next" links. */
export function readingOrder(groups) {
  return groups.flatMap((group) => group.pages.map((page) => page.file));
}
