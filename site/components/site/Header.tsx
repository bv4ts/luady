import { REPO_URL } from '../../lib/links.mjs';
import { asset, href } from './base';

/** The bar at the top of every page: the logo home, the docs, the live demo (when the build has it) and GitHub. */
export function Header({ current, docs = false, demo }: { current?: 'docs'; docs?: boolean; demo: boolean }) {
  return (
    <header className="topbar">
      <div className="topbar__in wrap">
        <a className="brand" href={href('')}>
          <img className="pixel" src={asset('brand/logo-32.png')} srcSet={`${asset('brand/logo-32.png')} 1x, ${asset('brand/logo-64.png')} 2x, ${asset('brand/logo-128.png')} 4x`} width={32} height={32} alt="" />
          <span>Luady</span>
          {docs ? <span className="brand__tag">docs</span> : null}
        </a>
        <nav className="topbar__nav" aria-label="Site">
          <a href={href('docs/')} aria-current={current === 'docs' ? 'page' : undefined}>Docs</a>
          {demo ? <a className="topbar__demo" href={href('demo/')}>Live demo</a> : null}
          <a href={REPO_URL}>GitHub</a>
        </nav>
      </div>
    </header>
  );
}
