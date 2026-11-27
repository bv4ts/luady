import type { Metadata } from 'next';
import { loadDocs, neighboursOf } from '../../lib/docs.mjs';
import { BRANCH, REPO_URL } from '../../lib/links.mjs';
import { pageMetadata } from '../../lib/meta.mjs';
import { BASE_PATH, SITE_URL, asset, href } from '../site/base';
import { HAS_DEMO, REPO_DIR } from '../site/build-info';
import { Footer } from '../site/Footer';
import { Header } from '../site/Header';
import { CopyButtons } from './CopyButtons';

interface DocPage { file: string; path: string; title: string; description: string; html: string }
interface Menu { group: string; pages: { file: string; label: string; path: string }[] }

export function docs() {
  return loadDocs(REPO_DIR, BASE_PATH);
}

/** The metadata of a docs page: "<title> · Luady docs", the overview as "Luady docs". */
export function docsMetadata(file: string): Metadata {
  const page = docs().pages.get(file) as DocPage | undefined;
  if (page === undefined) throw new Error(`site: no docs page for ${file}`);
  const title = file === 'README.md' ? 'Luady docs' : `${page.title} · Luady docs`;
  return pageMetadata({ siteUrl: SITE_URL === '' ? null : SITE_URL, path: page.path, title, description: page.description });
}

function MenuList({ menu, current }: { menu: Menu[]; current: string }) {
  return (
    <ul className="menu">
      {menu.map(({ group, pages }) => (
        <li className="menu__group" key={group}>
          <span className="menu__heading">{group}</span>
          <ul>
            {pages.map((p) => (
              <li key={p.file}>
                <a href={href(p.path)} aria-current={p.file === current ? 'page' : undefined}>{p.label}</a>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Pager({ prev, next }: { prev: DocPage | null; next: DocPage | null }) {
  if (prev === null && next === null) return null;
  return (
    <nav className="pager" aria-label="Previous and next page">
      {prev === null ? <span /> : (
        <a className="pager__prev" href={href(prev.path)} rel="prev"><span>Previous</span>{prev.title}</a>
      )}
      {next === null ? <span /> : (
        <a className="pager__next" href={href(next.path)} rel="next"><span>Next</span>{next.title}</a>
      )}
    </nav>
  );
}

/**
 * One docs page: the side menu (folded on a phone), the page rendered from its Markdown at build time, the previous
 * and next pages in reading order, and a link to edit it on GitHub.
 */
export function DocsPage({ file }: { file: string }) {
  const all = docs();
  const page = all.pages.get(file) as DocPage | undefined;
  if (page === undefined) throw new Error(`site: no docs page for ${file}`);
  const { prev, next } = neighboursOf(all, file) as { prev: DocPage | null; next: DocPage | null };
  const menu = all.menu as Menu[];
  return (
    <>
      <a className="skip" href="#main">Skip to the page</a>
      <Header docs current="docs" demo={HAS_DEMO} />
      <div className="shell">
        <nav className="side" aria-label="Documentation">
          <details className="side__fold">
            <summary>All pages</summary>
            <MenuList menu={menu} current={file} />
          </details>
          <div className="side__fixed">
            <MenuList menu={menu} current={file} />
          </div>
        </nav>
        <main id="main" className="page" tabIndex={-1}>
          <article className="prose" dangerouslySetInnerHTML={{ __html: page.html }} />
          <Pager prev={prev} next={next} />
          <p className="page__edit"><a href={`${REPO_URL}/blob/${BRANCH}/docs/${file}`}>Edit this page on GitHub</a></p>
        </main>
      </div>
      <Footer demo={HAS_DEMO}>
        <p className="foot__small">
          Luady is not affiliated with Anthropic; &ldquo;Claude&rdquo; and &ldquo;Claude Code&rdquo; are Anthropic&rsquo;s names.
          Headings use the Pixelify Sans font, under the SIL Open Font License (<a href={asset('fonts/pixelify-sans/OFL.txt')}>licence text</a>).
        </p>
      </Footer>
      <CopyButtons />
    </>
  );
}
