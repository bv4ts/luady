import type { ReactNode } from 'react';
import { BRANCH, REPO_URL } from '../../lib/links.mjs';
import { asset, href } from './base';
import { Skyline } from './Skyline';

/** The foot of every page: the skyline, the main links, and `children` for the page's own small print. */
export function Footer({ demo, children }: { demo: boolean; children?: ReactNode }) {
  return (
    <footer className="foot">
      <Skyline />
      <div className="foot__in wrap">
        <a className="brand" href={href('')}>
          <img className="pixel" src={asset('brand/logo-32.png')} srcSet={`${asset('brand/logo-32.png')} 1x, ${asset('brand/logo-64.png')} 2x, ${asset('brand/logo-128.png')} 4x`} width={32} height={32} alt="" loading="lazy" decoding="async" />
          <span>Luady</span>
        </a>
        <nav className="foot__nav" aria-label="Footer">
          <a href={href('docs/')}>Docs</a>
          {demo ? <a href={href('demo/')}>Live demo</a> : null}
          <a href={REPO_URL}>Repository</a>
          <a href={`${REPO_URL}/blob/${BRANCH}/LICENSE`}>Licence: Apache-2.0</a>
        </nav>
        {children}
      </div>
    </footer>
  );
}
