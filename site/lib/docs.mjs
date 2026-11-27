import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { imageSize } from './image-size.mjs';
import { pathOfDoc, slugOfFile } from './links.mjs';
import { renderDoc } from './markdown.mjs';
import { navFor, readingOrder } from './pages.mjs';

/** The Markdown files directly in docs/, sorted. Every one becomes a page. */
export function docsFiles(repoDir) {
  return readdirSync(join(repoDir, 'docs'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

const cache = new Map();

/**
 * Every docs page, rendered from docs/*.md at build time, so the site can never say something the docs do not:
 * `pages` maps a file name to { file, slug, path, title, description, html, ids }, `menu` is the side menu with each
 * page's title, and `order` the reading order for the previous and next links. `basePath` is '' or '/luady'.
 */
export function loadDocs(repoDir, basePath = '') {
  const key = `${repoDir}|${basePath}`;
  if (cache.has(key)) return cache.get(key);
  const files = docsFiles(repoDir);
  const present = new Set(files);
  const groups = navFor(files);
  const order = readingOrder(groups);
  const sizeOf = (href) => {
    const clean = href.split('#')[0].split('?')[0];
    const inDocs = posix.normalize(posix.join('docs', clean));
    return inDocs.startsWith('docs/assets/') ? imageSize(join(repoDir, inDocs)) : null;
  };
  const pages = new Map();
  for (const file of files) {
    const page = renderDoc(readFileSync(join(repoDir, 'docs', file), 'utf8'), present, { basePath, sizeOf });
    pages.set(file, { file, slug: slugOfFile(file), path: pathOfDoc(file), ...page });
  }
  const menu = groups.map(({ group, pages: list }) => ({
    group,
    pages: list.map((item) => ({ file: item.file, label: item.label ?? pages.get(item.file).title, path: pathOfDoc(item.file) })),
  }));
  const loaded = { files, pages, menu, order };
  cache.set(key, loaded);
  return loaded;
}

/** The previous and next pages around `file` in reading order (null at either end). */
export function neighboursOf(docs, file) {
  const at = docs.order.indexOf(file);
  const pick = (i) => (i < 0 || i >= docs.order.length ? null : docs.pages.get(docs.order[i]));
  return at === -1 ? { prev: null, next: null } : { prev: pick(at - 1), next: pick(at + 1) };
}
