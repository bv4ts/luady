# Docs pictures

Retakes the pictures in `docs/assets/` from the running product: the demo (the real hub and website with a pretend
fleet, `npm run demo`), driven by Playwright. Run it when the look changes. It is a maintainer's tool: it is not part of
CI and adds no dependency.

Two files are not made here: the drawing `how-it-works.svg`, and `feature-addons.png`, the Channels card with one channel
add-on connected. The demo attaches no add-on (it has no stand-in chat channel any more), so it can only show an empty
card; that picture is kept as it is.

## What you need

- The workspace installed and built: `npm ci`, then `npm run build` (the script builds when the build is missing or
  older than the sources, as `npm run demo` does).
- Playwright, from the browser tests' folder (the same version):
  `npm --prefix tests/integration ci` and `npm --prefix tests/integration exec -- playwright install chromium`.
- For the animation: Python 3 with Pillow (`pip install Pillow`).

## Run it

```sh
node --experimental-strip-types scripts/docs-pictures/capture.mjs
```

It takes a few minutes and writes into `docs/assets/`, each picture at the size the README, the docs and the website
show it (it refuses a picture of another size). Options:

| Option | What it does |
|---|---|
| `--only a.png,b.png` | Only these pictures (`office-demo.webp` is the animation), or a group: `office`, `first-run` |
| `--out <folder>` | Write somewhere else, to compare first |
| `--frames <folder>` | Where the animation's frames go (default: a folder in the system's temp folder) |
| `--clock <ISO time>` | The office clock (default `2026-11-21T14:07:30Z`, see below) |
| `--python <exe>` | The Python that runs `assemble_webp.py` (default `python` on Windows, else `python3`) |
| `--any-size` | Write a picture even when its size is not the one the pages expect (with a warning) |

Look at every picture before you commit it.

## How each picture is reached

Two demos run one after the other, each on a free port, with nothing moving on its own (`--still`) and a fixed office
clock: 18:07:30 in the demo owner's zone, the middle of dusk, where the office shows its own art. The browser uses a
fixed zone and language, so the machine's own do not matter. The top bar's clock would show the computer's real time:
the script writes the office clock's time there instead (6:07 PM), and changes nothing else on the page.

**A new install** (`first-run.mjs`). The demo always finishes its own first run, so the script starts one with no rooms
and puts its database back to a new install's first-run rows: no PIN, no servers, the wizard at its first step, the
manager off, no time zone. The browser runs in UTC, so the claim stores UTC. Then, each 880 pixels wide from the
top of the page (560 high; `setup-open.png` as high as its whole card needs):

- `setup-claim.png`: the first page. The setup code comes from the hub; a virtual passkey says yes.
- `setup-pin.png`, `setup-rooms.png`: the next two steps (the PIN is the demo's, `123456`).
- `setup-open.png`: rooms and connect skipped, extras kept (manager off).
- `settings.png` (1440 x 900): Settings with no servers yet, scrolled so that the next card on the left starts just
  below the window (no sticky save bar over a field) and the Servers card is wholly in view.
- `add-server-details.png`, `add-server-key-line.png`: Settings → Add a server for `oak.example.invalid` (name `oak`,
  user `dev`), then, after the PIN, its key line. The key in that line is the demo's own key, made new in the demo's
  temporary folder on each run.

**The office** (`office.mjs`, `office-views.mjs`, `animation.mjs`), on the classic demo. The script removes the demo's
four rooms and adds its own in the room editor, as an owner does: Cedar on `cedar`, Birch on `birch`, Ash on `ash`, each
in the colour and creature the editor offers. Each room's links go back on its shelf. It also switches the demo's quiet
hours off: they dim HQ by the computer's real clock (midnight to 8 AM), not by the office clock. Pages are opened only
once the demo's first notices are 15 seconds old, so they are listed, not popped up.

- `phone.png`: the office with no rooms yet, 390 x 844 at twice the density.
- `room-editor.png`: the editor for Cedar on the empty office; `feature-rooms.png`: the same editor drawn at 3/4 size.
- `room-panel.png`: right after "Add the room": the camera on Cedar, its panel open.
- `office-demo.webp`: on the office with Cedar and Birch, Ash is added, then the camera visits the rooms. A 1280 x 800
  screen drawn at 800 x 500; a frame every 120 ms; `assemble_webp.py` fades the end into the start and picks the best
  quality under about 1.45 MB.
- `office.png`, `rooms-menu.png`: the office with its three rooms, then with the Rooms menu open.
- `feature-servers.png`: the same office drawn at 800 x 500.
- `feature-manager.png`: the middle of HQ in the whole-office view, around the manager's desk, drawn at the device
  scale that makes each map pixel exactly 2 x 2 pixels of the picture.
- `pin-confirm.png` (`confirmation.mjs`): the manager asks, through the hub's action service as its `session_send` tool
  does, to send a two-line message to `meadow-hr` in Cedar. Outside the owner's own turn that waits for the PIN, and
  the Inbox shows the card; it is taken 448 pixels wide, then the request is denied.

Nothing is scaled after the browser has drawn it: a smaller picture is drawn smaller by the browser itself.
