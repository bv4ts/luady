# Where the website's pixel art comes from

Every sprite the website animates (the office toy on the landing page, the small scenes on the feature cards, the
terminals-to-office scene and the 404 page) is the product's own art, drawn by the product's own code. Nothing in
`site/public/pixel/` is drawn by hand for the site. The real screenshots on the pages are separate: they come from
`docs/assets/` at build time.

## What is in `site/public/pixel/`

| File | What it is |
|---|---|
| `office-world.png` | The five-room demo office (Cedar, Oak, Ash, Birch around Luady HQ) with four empty lots, as the office page draws it: grass, garden, walls, floors and room frames, without furniture or creatures. 48 px of garden on each side. |
| `rooms.png` | The insides of four rooms that the toy builds on the empty lots (Elm, Aspen, Olive, Hemlock), plus Cedar and an empty lot with their frames, for the terminals scene and the 404 page. |
| `sprites.png` | One atlas of the small pieces: every creature species in nine room colours (idle, blink and step frames, 24 x 24 cells), desks, monitors and their screens, furniture, the bubble icons, the working ring, sparkles and lamp light. |
| `office-still.png` | The toy's first view as one picture, for visitors without JavaScript and for the moment before the toy starts. |
| `manifest.json` | Where everything is: atlas frames, the office layout (rooms, doorways, desks, props, creatures, lamps) and, for each lot, the room it becomes. |

The office's names (Cedar, Oak, Ash, Birch, Elm, ...) and the session names are the made-up ones the product's demo
uses. No real server, person or project appears.

## How it is made

1. **Export from the product's drawing code.** The office package (`packages/office`) draws everything the office page
   shows. A small script imports its build (`npm run build`, then `packages/office/dist/index.js`) and writes PNG files
   from its raster functions:
   - `buildOffice(rooms)` for a made-up office of 1, 3, 4, 5 and 24 rooms, then `chunkRaster` and `chunkPlacement` for
     its garden and building, and `roomRectPx` for the 2 px room frames, give `office-<n>-base.png` and the layout
     (`office-<n>.json`: rooms, doorways, `desksFor`, `propsFor`, `lampFeet`); `lotRoom(slot)` gives the variant with
     Elm still an empty lot (`office-5lot-base.png`);
   - `furnitureRaster(kind)`, `monitorScreen(glow, palette)`, `bubbleRaster(icon)`, `ringRaster`, `sparkleRaster`,
     `dropRaster`, `groundRaster` and `glowPoolRaster` give the small sprites;
   - the creatures come from the web app's own atlas (`packages/web/src/features/agency/assets/characters.png` and
     `.json`), recoloured exactly as the office scene does it, one sheet per room colour (`critters-<colour>.png`).

   The export writes a `manifest.json` that lists each file with its size and anchor (for a desk: the monitor sits at
   (30, -9) and its screen at (31, -8); for a creature: the bottom centre of its 24 x 24 cell is its feet; for a
   bubble: x = feet.x + 3, y = feet.y - 23 + tail - 14).

2. **Pack it for the site.** `pack-pixel-art.py` (next to this file, needs Pillow) crops and packs that export into
   the files above, without resampling a single pixel:

   ```sh
   python site/scripts/pack-pixel-art.py <folder of the export> site/public/pixel
   ```

   A room's frame lies 2 px outside its rectangle, on its neighbour's outermost pixels, so the room insides are cropped
   without frames (a flat stripe a neighbour painted goes back to the wall colour), and the site draws every frame
   itself, in the office's order, the way the product does.

Re-run both steps when the product's art changes, then look at the landing page, a feature card and the 404 page.
