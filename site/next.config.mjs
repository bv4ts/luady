/**
 * The Luady website as a static export: plain files in site/dist that any web server or GitHub Pages can serve, with
 * no Node.js process behind them. Run it through build.mjs (`npm run build`), which checks the one setting, SITE_URL,
 * and finishes the export (security policy, old addresses, sitemap). See site/README.md.
 */
import { basePathOf, parseSiteUrl } from './lib/site-url.mjs';

const siteUrl = parseSiteUrl(process.env.SITE_URL);
const basePath = basePathOf(siteUrl);

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // The export goes to site/dist, where the Pages workflow and the upload steps expect it.
  distDir: process.env.LUADY_DIST_DIR || 'dist',
  // Served under a folder such as /luady/: every link and file starts with it.
  basePath,
  // Clean folder addresses: /docs/rooms/ is written as docs/rooms/index.html.
  trailingSlash: true,
  // No image server behind a static site: pictures are served as they are.
  images: { unoptimized: true },
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // Values the pages read while they are built (and the office toy reads in the browser, to find its pictures).
  env: {
    LUADY_BASE_PATH: basePath,
    LUADY_SITE_URL: siteUrl ?? '',
  },
};

export default config;
