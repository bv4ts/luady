import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docsFiles } from '../../lib/docs.mjs';
import { plainSvg } from '../../lib/sanitize.mjs';

/**
 * Facts about the build, read while the pages are written (never in the browser). Next.js runs the build in site/,
 * so the repository is its parent folder.
 */
export const SITE_DIR = process.cwd();
export const REPO_DIR = join(SITE_DIR, '..');

/** The live demo is part of this build (build.mjs found the demo's own build and copies it to demo/). */
export const HAS_DEMO = process.env.LUADY_DEMO === '1';

/** The launch film, when site/public/media/launch-film.mp4 is there at build time. */
export const FILM_PATH = 'media/launch-film.mp4';
export const HAS_FILM = existsSync(join(SITE_DIR, 'public', FILM_PATH));

export function docsPageSet(): Set<string> {
  return new Set(docsFiles(REPO_DIR));
}

/**
 * docs/assets/how-it-works.svg, ready to put inside a page: its ids get a prefix (so they cannot clash with the page's
 * own), and its links to them follow. The file itself is not changed.
 */
export function howItWorksSvg(): string {
  // The drawing becomes part of the page, so it must be a drawing only (sanitize.mjs says what that means).
  const svg = plainSvg(readFileSync(join(REPO_DIR, 'docs', 'assets', 'how-it-works.svg'), 'utf8'), 'docs/assets/how-it-works.svg');
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  let out = svg.replace(/<\?xml[^>]*>\s*/, '');
  for (const id of ids) {
    out = out
      .replace(new RegExp(`\\sid="${id}"`, 'g'), ` id="how-${id}"`)
      .replace(new RegExp(`url\\(#${id}\\)`, 'g'), `url(#how-${id})`)
      .replace(new RegExp(`href="#${id}"`, 'g'), `href="#how-${id}"`);
  }
  return out.replace(/aria-labelledby="([^"]+)"/, (_all, list: string) => `aria-labelledby="${list.split(/\s+/).map((id) => `how-${id}`).join(' ')}"`)
    .replace('<svg ', '<svg class="how__svg" ');
}
