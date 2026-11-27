import type { Metadata } from 'next';
import { pageMetadata } from '../lib/meta.mjs';
import { LostScene } from '../components/landing/LostScene';
import { href } from '../components/site/base';
import { HAS_DEMO } from '../components/site/build-info';
import { Footer } from '../components/site/Footer';
import { Header } from '../components/site/Header';
import './not-found.css';

export const metadata: Metadata = pageMetadata({
  siteUrl: null, path: '', title: 'Not found · Luady', description: 'There is no page at this address.', noindex: true,
});

/**
 * The page a host shows for an address the site does not have (404.html). Its links start with the site's base path,
 * so they work at any depth.
 */
export default function NotFound() {
  return (
    <>
      <a className="skip" href="#main">Skip to the page</a>
      <Header demo={HAS_DEMO} />
      <main id="main" className="missing wrap" tabIndex={-1}>
        <LostScene />
        <h1 id="not-found">Not found</h1>
        <p>There is no page at this address. It may have moved.</p>
        <ul className="missing__links">
          <li><a className="btn btn--primary" href={href('')}>The Luady home page</a></li>
          <li><a className="btn" href={href('docs/')}>The docs overview</a></li>
          {HAS_DEMO ? <li><a className="btn" href={href('demo/')}>The live demo</a></li> : null}
        </ul>
      </main>
      <Footer demo={HAS_DEMO} />
    </>
  );
}
