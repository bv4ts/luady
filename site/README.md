# The Luady website

This folder builds Luady's public website into `site/dist/`: a [Next.js](https://nextjs.org/) site (App Router, React,
TypeScript) exported as plain static files, so it runs on GitHub Pages or behind any web server with no Node.js
process.

| Page | From | Address |
|---|---|---|
| The landing page | `app/page.tsx`, with its README claims read from `README.md` at build time | `/` |
| The docs overview | `docs/README.md` | `/docs/` |
| Every other docs page | `docs/<name>.md` | `/docs/<name>/`, such as `/docs/rooms/` |
| The live demo | the web package's demo build, copied in by the build | `/demo/` |
| Not found | `app/not-found.tsx` | `404.html` |
| The old addresses | small pages that forward, keeping the `#section` | `docs.html`, `rooms.html`, ... |

The docs pages are rendered from the Markdown in `docs/` every time the site is built, so the website cannot drift from
the docs. The side menu follows the order in `lib/pages.mjs`; a page that is not listed there appears under "More".

## Build

```sh
npm ci --prefix site
npm run build --prefix site
```

`build.mjs` runs `next build` (with Next.js's telemetry off) and then finishes the export: it gives every page its
Content-Security-Policy, writes the old-address pages, `sitemap.xml` and `robots.txt`, copies the font's licence, and
copies the live demo in when its build is there. Node.js 22.12 or newer. The tools need four packages: `next`, `react`,
`react-dom` and `marked`. `sharp`, an optional image library of Next.js, is replaced by a stub in `vendor/no-sharp`:
image optimisation is off, and the stub keeps sharp's LGPL image libraries out of the install.

## The one setting: where the site is served

`SITE_URL` (or the `--base-url` flag, which wins over it) is the address the site is served from. From it come:

- the base path every link and file starts with: `/luady/...` for `https://example.com/luady/`;
- the canonical link, and the Open Graph and Twitter card tags with the link-preview picture, on every page;
- `sitemap.xml` and `robots.txt`;
- the demo's Content-Security-Policy, narrowed to the demo's own folder.

Without the setting the site is built for the root of a host (`/`) and has none of the absolute tags, sitemap or
robots.txt. The address must be `https://` (plain `http://` only for `localhost` or `127.0.0.1`), the folder the site is
served from, with no query or `#fragment`. A missing trailing `/` is added. Build once per address: a build for
`/luady/` works only under `/luady/`.

```sh
# GitHub Pages, as the Pages workflow does it
SITE_URL=https://bv4ts.github.io/luady/ npm run build --prefix site

# A sub-path of your own domain
SITE_URL=https://example.com/luady/ npm run build --prefix site
# or
node site/build.mjs --base-url https://example.com/luady/
```

In Windows PowerShell: `$env:SITE_URL = 'https://example.com/luady/'; npm run build --prefix site`.

## The live demo

The demo is the web package's office page against a pretend hub. Build it first, with relative paths; the site's
build then finds it in `packages/web/demo/dist`, links to it from the pages, and copies it to `demo/` with a policy
that allows only its own folder and a small link back to the website:

```sh
npm ci
(cd packages/web && npx vite build --config vite.demo.config.ts --base ./)
SITE_URL=https://example.com/luady/ npm run build --prefix site
```

Without the demo build the pages do not link to the demo at all (the office toy's button then points at how to run the
demo on your computer), so no link leads nowhere. `node site/demo.mjs --base-url <address>` copies the demo into an
existing `site/dist` on its own, but the pages built without it still do not link to it: build the demo first.

## The launch film

If `site/public/media/launch-film.mp4` is there when the site is built, the landing page shows a "Watch the film"
player under the hero's buttons (it loads nothing until it is opened). Without the file, nothing is shown.

## Check and test

```sh
npm test --prefix site                    # the tools, and two real builds (root and sub-path) in folders of their own
SITE_URL=https://example.com/luady/ npm run check --prefix site   # every internal link and #anchor in site/dist
```

The tests hold the site to these rules: every docs page and old address is there; every internal link and anchor
resolves; nothing is loaded from another site, scripts included; every page's policy comes first and names each of its
inline scripts by hash, and only Next.js's own get one, with no inline style or event handler; hostile Markdown, a
hostile README and a hostile drawing come out harmless (`test/hostile.test.mjs`); the absolute tags, sitemap and
robots.txt come only from the setting; the 404 page links from the site's folder; the landing page's "What it is",
feature, "How it works" and security text, and its permission sentence, are the README's; text colours meet WCAG AA
(`test/contrast.test.mjs`); the landing page stays under its weight budget. Long code in `docs/` is listed as a note,
never a failure.

Give the link checker the same `SITE_URL` the site was built with. `check:strict` also fails when the demo is missing;
the Pages workflow runs it that way.

## Preview on your computer

```sh
npm run dev --prefix site                 # live reload at http://localhost:3000
```

To see the export itself, serve `site/dist` with any static server, under the folder it was built for: for a build with
`SITE_URL=http://127.0.0.1:8080/luady/`, serve a folder that holds `site/dist` under the name `luady` and open
`http://127.0.0.1:8080/luady/`.

## Deploy

### GitHub Pages

`.github/workflows/pages.yml` tests the site, builds the demo and then the site, checks every link, and publishes
`site/dist` on every push to `main`. Once, in the repository settings: **Pages → Build and deployment → Source: GitHub
Actions**. A repository variable named `SITE_URL` (Settings → Secrets and variables → Actions → Variables) sets the
public address, for a custom domain for example; without it the build uses `https://<owner>.github.io/<repository>/`.

### Any static host, under a sub-path

1. Build with the address the site will have, with the demo, and check:

   ```sh
   export SITE_URL=https://example.com/luady/
   npm ci && (cd packages/web && npx vite build --config vite.demo.config.ts --base ./)
   npm ci --prefix site && npm run build --prefix site
   npm run check:strict --prefix site
   ```

2. Upload the contents of `site/dist/` to the folder that address points at (here `/luady/` on `example.com`).
3. Have the host answer unknown addresses below that folder with `404.html` (for nginx:
   `error_page 404 /luady/404.html;`), serve `.webp` as `image/webp` and `.txt` as `text/plain`, and redirect a folder
   address without its last `/` to the one with it (most hosts do).

Every page carries its Content-Security-Policy in a `<meta>` tag. A host may also send one as a header; it must allow
the same things, or the pages' own scripts will not run. A `<meta>` policy cannot forbid framing, so have the host
send that as a header itself (`Content-Security-Policy: frame-ancestors 'none'`, or `X-Frame-Options: DENY`).

Crawlers read `robots.txt` only at the root of a host. Under a sub-path the file is there for people; submit
`sitemap.xml` to search engines yourself if you want to.

## How it is made

| Where | What |
|---|---|
| `app/` | The pages and their stylesheets: `page.tsx` (landing), `docs/` (the docs), `not-found.tsx`, `globals.css` (the colours, type and shared pieces). |
| `components/toy/` | The office toy at the top of the landing page: a small simulation (`sim.ts`), its drawing (`draw.ts`), Luady's routes through the office (`world.ts`), and the React layer with a real button for every session. |
| `components/landing/` | The terminals that fold into a room, the small scenes on the feature cards, the 404 scene. |
| `components/pixel/` | Loading and drawing the product's sprites at whole-number scales, and running scenes only while they are on screen. |
| `lib/` | Build-time tools in plain JavaScript, shared by the pages, `build.mjs`, the link checker and the tests. |
| `public/pixel/` | The product's own pixel art; where it comes from and how to remake it: `scripts/export-pixel-art.md`. |
| `public/brand/` | The logo and the link-preview picture (`scripts/make-social-card.py` draws it). |
| `fonts/pixelify-sans/` | The heading font, with its licence. |

Every animation runs only while it is on screen and the tab is visible, and stands still for visitors who asked their
system for less motion. Without JavaScript every page is complete: the office toy and the scenes show still pictures.

Screenshots in the docs must come from a hub with made-up data (the neutral names in the docs: `ash`, `birch`, `cedar`,
`oak`, the user `dev`, and addresses under `.invalid` or `example.com`). Keep each new picture under about 300 KB, and
keep PNG for pixel art. Everything in `docs/assets/` is published on the website as it is, at `assets/`: keep only
pictures there, and no SVG with a script, embedded HTML or a link in it.

Raw HTML written in `docs/*.md` or in the parts of `README.md` the landing page shows keeps only a short list of tags
and attributes (`lib/sanitize.mjs`: links, pictures with `<picture>` and `<source>`, paragraphs, line breaks, emphasis,
`<sub>`, `<sup>`, `<code>`, `<kbd>` and tables); any other tag shows as text, and a link or picture keeps its address
only when it is relative (or http, https or mailto for a link). The build also refuses any inline script that Next.js
did not write.

The headings use Pixelify Sans, under the SIL Open Font License (`fonts/pixelify-sans/OFL.txt`).
