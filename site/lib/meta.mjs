import { absoluteUrl } from './site-url.mjs';

export const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The picture link previews show (site/public/brand/social-card.png). */
export const SOCIAL_CARD = {
  path: 'brand/social-card.png',
  width: 1280,
  height: 640,
  alt: 'The Luady logo, a small pixel-art office building with the manager\'s face in its middle window, the name Luady and '
    + 'the line "A pixel-art office for your Claude Code sessions", over the office at night: small creatures working at '
    + 'their desks in one room, next to the manager\'s headquarters.',
};

export const SITE_NAME = 'Luady';

/** The address a page is known by: its folder (`docs/rooms/`), or the site's own address for the home page. */
export function canonicalOf(siteUrl, path) {
  return absoluteUrl(siteUrl, path === '' ? './' : path);
}

/**
 * The page's metadata for Next.js: title and description always; the canonical link, Open Graph and the Twitter card
 * only when the site's address is known (without it there is nothing absolute to point at, so they are left out rather
 * than guessed); noindex for pages that should stay out of search results.
 */
export function pageMetadata({ siteUrl, path, title, description, noindex = false }) {
  const meta = { title, description };
  if (noindex) meta.robots = { index: false, follow: true };
  if (siteUrl === null) return meta;
  const url = canonicalOf(siteUrl, path);
  const image = { url: absoluteUrl(siteUrl, SOCIAL_CARD.path), width: SOCIAL_CARD.width, height: SOCIAL_CARD.height, alt: SOCIAL_CARD.alt };
  return {
    ...meta,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: SITE_NAME, title, description, url, images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [{ url: image.url, alt: image.alt }] },
  };
}

/** sitemap.xml for the pages the build writes (site paths such as '' and 'docs/rooms/'; the 404 page is left out). */
export function sitemapXml(siteUrl, paths) {
  const urls = paths.map((path) => `  <url><loc>${esc(canonicalOf(siteUrl, path))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * robots.txt: everything may be crawled, and here is the sitemap. Crawlers read robots.txt only at the root of a host,
 * so under a sub-path (a GitHub project site) this file is a pointer for people; submit the sitemap by hand there.
 */
export function robotsTxt(siteUrl) {
  return `User-agent: *\nDisallow:\n\nSitemap: ${absoluteUrl(siteUrl, 'sitemap.xml')}\n`;
}
