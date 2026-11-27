# Contributing to Luady

Thanks for helping. Luady is a self-hosted pixel-art office: every Claude Code
session is a small creature at a desk, every server or project is a room, and
an optional manager takes your instructions. This file explains how to help and
what a good contribution looks like.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
**Security problems are never reported in a public issue.** Report them
privately, as described in [SECURITY.md](SECURITY.md).

## Ways to help

- **Report a bug** with the bug form under
  [Issues](https://github.com/bv4ts/luady/issues/new/choose). It asks for your
  version, system and the output of `npm run doctor`; remove anything private
  from that output before you paste it.
- **Suggest an idea** with the idea form, or start a thread in
  [Discussions](https://github.com/bv4ts/luady/discussions) if you are not sure
  yet. Ask and answer questions there too.
- **Improve the docs**: wording, examples, screenshots.
- **Draw**: sprites, furniture, wallpapers (see "Artwork and other assets").
- **Write code.** Pick an issue, or open one first for anything larger than a
  small fix, so we can agree on the approach before you spend time on it.

## Development setup

You need Node.js 22.12 or newer (`.nvmrc` has the version CI uses) with npm,
and Git. Bash and Python 3.10 or newer are needed only for the install scripts
and the kit that runs on servers. Docker is needed only for the kit,
integration and end-to-end tests.

```sh
git clone https://github.com/bv4ts/luady.git
cd luady
npm ci
npm run build
```

The code is an npm workspace:

| Folder | What it is |
|--------|------------|
| `packages/hub` | The server, with its SQLite database |
| `packages/web` | The website (React and PixiJS) |
| `packages/office` | The office engine: layout, paths, sprites |
| `packages/mcp` | The MCP server that lets the manager talk to the hub |
| `packages/shared` | Types and schemas shared by the packages above |
| `packages/addon-sdk` | Client for Add-on Protocol v1 (see its README) |
| `server-kit/` | The kit: the Python program installed on servers, and its tests |
| `deploy/` | `systemd/luady.user.service`, the service the quickstart uses; the rest is the maintainers' own server recipe, not supported |
| `brain/` | Templates for the manager's working folder |
| `preview/` | A fake-fleet preview of the whole app |
| `tests/integration/` | Docker integration and Playwright tests (not a workspace) |

Run it while you work (build first):

```sh
npm start                               # the hub (prints a setup code in a terminal)
npm run dev --workspace @luady/web      # the website, with hot reload
npm run preview                         # hub and website against fake servers, no real machines
```

## Tests

Please run these before you open a pull request. CI runs the same ones.

```sh
npm run build
npm run typecheck           # the literal gate (scripts/check-literals.mjs), then every package's tsc
npm run typecheck:preview
npm test                    # unit tests of every package
npm run test:preview
npm run test:scripts
npm run licence:check       # fails on a GPL, LGPL, AGPL or SSPL licence; rewrites THIRD_PARTY_LICENSES.md
```

- One package: `npm test --workspace @luady/hub` (also `web`, `office`, `mcp`,
  `shared`, `addon-sdk`). `npm run coverage` runs them with coverage and fails
  under the thresholds in each `vitest.config.ts` (80% of lines).
- The built website: `npm run test:dist --workspace @luady/web`, after a build.
- Docker suites, slower: `npm run test:kit` (the kit, 80% line
  coverage), `npm run test:integration` and `npm run test:e2e` (the second
  installs Chromium through Playwright).

Every pull request and every push to `main` runs the build, the typecheck, the
unit tests, the kit tests and the integration tests on GitHub. The browser suite
is run on your own machine, with `npm run test:e2e`, before a change to the
website's office view.

Two switches of the browser suite:

- `LUADY_UPDATE_PIXELS=1` writes the pixel baselines (`tests/integration/e2e/pixels/`)
  for the platform you run on. A platform that has no baselines yet skips the
  picture tests and says so.
- `LUADY_SCALE_STRICT=1` makes the scale spec's frame-time limit a hard check.
  Without it the measured time is printed; the memory, object and texture
  budgets are always checked. A machine without a graphics card draws the
  office in software and cannot meet the frame-time limit.

The literal gate fails the typecheck when code compares a host with a literal
server name or writes the self-host id outside the files that own it. Compare
hosts through `isSelfHost()` or fleet membership instead.

## Rules

- **Tests first.** Add or update tests for the behaviour you change. A bug fix
  comes with a test that fails without the fix. Tests must not need real
  accounts, secrets or network access to third-party services.
- **Never commit secrets, real names or real addresses.** No keys, tokens,
  passwords, `.env` files or databases. No real people's names, e-mail
  addresses, phone numbers, company or client names, domains or IP addresses in
  code, tests, fixtures, screenshots or docs. Use made-up names: `ash`, `birch`,
  `cedar` and `oak` for servers, the user `dev`, and addresses under `.invalid`
  or `example.com` (such as `user@example.com`). For IP addresses use the
  documentation ranges: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`
  (IPv4) and `2001:db8::/32` (IPv6).
- **Conventional commits**: `<type>: <short description>`, with an optional body
  that says what changed and why. Types: `feat`, `fix`, `refactor`, `docs`,
  `test`, `chore`, `perf`, `ci`. For example `fix: keep a creature at its desk
  after the hub restarts`. A scope, as in `fix(hub): ...`, is optional.
- **No sign-off required.** You do not need `Signed-off-by` lines. By
  submitting a contribution you license it under the Apache License 2.0, as
  described in section 5 of the [LICENSE](LICENSE).

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep the change focused: one topic per pull request is easier to review.
3. Make sure build, typecheck and the tests above pass locally.
4. Open the pull request and fill in the template (tests, docs, no private
   data, a screenshot for anything visible).
5. CI must pass. A maintainer reviews, may ask for changes, and merges.

If you add or update a dependency, run `npm run licence:check` and commit the
regenerated `THIRD_PARTY_LICENSES.md`. Dependencies must be under a licence that
is compatible with Apache-2.0.

## Add-ons

Chat channels and extra tools for the manager are add-ons: separate programs
that speak Add-on Protocol v1. Start with
[packages/addon-sdk/README.md](packages/addon-sdk/README.md). Open an idea first
for a new kind of add-on capability.

## Artwork and other assets

- Say who made it and under which licence you offer it. It must be compatible
  with Apache-2.0.
- Say if any part was made with an AI image tool, and which one.
- Do not include logos, brand colours or other trademarked material.
- Do not copy assets from other projects unless their licence allows it. Include
  the licence text and the source link.

## Questions

Ask in [Discussions](https://github.com/bv4ts/luady/discussions).
