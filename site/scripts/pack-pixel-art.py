"""Packs the product's exported pixel art into site/public/pixel: the office world, room shells, a sprite atlas, a
still of the office toy's first view, and manifest.json. Whole pixels only: crops and copies, never resampled.

    python site/scripts/pack-pixel-art.py <folder of the product export> site/public/pixel

See export-pixel-art.md next to this file for where the export comes from. Needs Pillow."""
import json
import sys
from pathlib import Path
from PIL import Image

if len(sys.argv) != 3:
    sys.exit("usage: python pack-pixel-art.py <product export folder> <output folder>")
SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
M = 320  # map (0,0) sits at this pixel of every office picture

o5 = json.load(open(SRC / "office-5.json"))
o24 = json.load(open(SRC / "office-24.json"))

# ---------------------------------------------------------------- the world: office-5 with Elm still an empty lot
PAD = 48
WORLD = {"x": -PAD, "y": -PAD, "w": o5["width"] + 2 * PAD, "h": o5["height"] + 2 * PAD}
lot = Image.open(SRC / "office-5lot-base.png").convert("RGBA")
world = lot.crop((M + WORLD["x"], M + WORLD["y"], M + WORLD["x"] + WORLD["w"], M + WORLD["y"] + WORLD["h"]))
world.save(OUT / "office-world.png", optimize=True)

# ---------------------------------------------------------------- room shells (floor and walls) for the lots
# A room's frame is drawn 2 px outside its rectangle, so a neighbour's frame lies on the room's outermost 2 px. The
# site draws every frame itself, in map order, so a shell is the inside only; a stripe that a neighbour in the source
# map painted (one flat frame colour) goes back to the wall colour, which is what a room without that neighbour has.
FRAME = 2
WALL = (21, 26, 39, 255)
def shell(picture, rect):
    img = picture.crop((M + rect["x"], M + rect["y"], M + rect["x"] + rect["w"], M + rect["y"] + rect["h"]))
    px = img.load(); w, h = img.size
    # each stripe: all its pixels, and its core (without the FRAME pixels at each end, where two stripes meet)
    stripes = [
        ([(x, y) for y in range(FRAME) for x in range(w)], [(x, y) for y in range(FRAME) for x in range(FRAME, w - FRAME)]),
        ([(x, y) for y in range(h - FRAME, h) for x in range(w)], [(x, y) for y in range(h - FRAME, h) for x in range(FRAME, w - FRAME)]),
        ([(x, y) for x in range(FRAME) for y in range(h)], [(x, y) for x in range(FRAME) for y in range(FRAME, h - FRAME)]),
        ([(x, y) for x in range(w - FRAME, w) for y in range(h)], [(x, y) for x in range(w - FRAME, w) for y in range(FRAME, h - FRAME)]),
    ]
    for whole, core in stripes:
        colours = {px[x, y] for x, y in core}
        if len(colours) == 1 and WALL not in colours:
            bad = colours.pop()
            for x, y in whole:
                if px[x, y] == bad: px[x, y] = WALL
    return img

def framed(img, colour):
    out = Image.new("RGBA", (img.width + 2 * FRAME, img.height + 2 * FRAME), colour)
    out.alpha_composite(img, (FRAME, FRAME))
    return out

def hexrgba(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)

base5 = Image.open(SRC / "office-5-base.png").convert("RGBA")
base24 = Image.open(SRC / "office-24-base.png").convert("RGBA")
# lot id in office-5 -> (source layout, source room id)
BUILDS = [
    ("elm", o5, "elm", base5),
    ("lot-6", o24, "aspen", base24),
    ("lot-5", o24, "olive", base24),
    ("lot-7", o24, "hemlock", base24),
]
shells = []
builds = []
for lot_id, layout, src_id, pic in BUILDS:
    room = layout["room"][src_id]
    target = o5["room"][lot_id]["rect"]
    dx = target["x"] - room["rect"]["x"]; dy = target["y"] - room["rect"]["y"]
    shells.append((src_id, shell(pic, room["rect"])))
    desks = [{"desk": {"x": d["desk"]["x"] + dx, "y": d["desk"]["y"] + dy}, "sit": {"x": d["sit"]["x"] + dx, "y": d["sit"]["y"] + dy}}
             for d in layout["desks"] if d["room"] == src_id]
    props = [{"kind": p["kind"], "x": p["x"] + dx, "y": p["y"] + dy, "sortY": p["sortY"] + dy}
             for p in layout["props"] if p["room"] == src_id]
    door = room["doorway"]
    builds.append({"lot": lot_id, "id": src_id, "name": room["name"], "rect": target, "palette": room["palette"],
                   "species": room["species"], "shell": src_id, "desks": desks, "props": props,
                   "doorway": {"x": door["x"] + dx, "y": door["y"] + dy, "w": door["w"], "h": door["h"]},
                   "side": room["side"], "orientation": room["orientation"]})
# Cedar with its frame, for the terminals-to-office scene, and an empty lot with its frame for the 404 page.
shells.append(("cedar", framed(shell(base5, o5["room"]["cedar"]["rect"]), hexrgba(o5["room"]["cedar"]["palette"]["base"]))))
shells.append(("lot", framed(shell(lot, o5["room"]["elm"]["rect"]), hexrgba(o5["room"]["lot-5"]["palette"]["base"]))))

rooms_frames = {}
x = y = row_h = 0
for name, img in shells:
    if x + img.width > 2 * 422:
        x = 0; y += row_h + 1; row_h = 0
    rooms_frames[name] = {"x": x, "y": y, "w": img.width, "h": img.height}
    x += img.width + 1; row_h = max(row_h, img.height)
rooms_img = Image.new("RGBA", (2 * 422 + 1, y + row_h), (0, 0, 0, 0))
for name, img in shells:
    f = rooms_frames[name]; rooms_img.alpha_composite(img, (f["x"], f["y"]))
rooms_img.save(OUT / "rooms.png", optimize=True)

# ---------------------------------------------------------------- the sprite atlas
COLOURS = {"rose": "#d6336c", "cyan": "#19b6d2", "violet": "#7c5cff", "amber": "#f76707", "moss": "#6f9a3a",
           "lilac": "#a78bfa", "cocoa": "#b07a4a", "orchid": "#c04fd6", "teal": "#3cc3b0"}
items = []
for name in COLOURS:
    items.append((f"critters-{name}", Image.open(SRC / f"critters-{name}.png").convert("RGBA")))
for folder in ["furniture", "bubbles", "marks", "pools"]:
    for f in sorted((SRC / folder).glob("*.png")):
        items.append((f"{folder}/{f.stem}", Image.open(f).convert("RGBA")))
for f in ["off", "alert", "error"] + [f"work-{c}" for c in COLOURS]:
    items.append((f"screens/{f}", Image.open(SRC / "screens" / f"{f}.png").convert("RGBA")))

# shelf packing, tallest first, 1 px gutter so neighbours never bleed
items.sort(key=lambda it: (-it[1].height, it[0]))
WIDTH = 512
x = y = row_h = 0
frames = {}
for name, img in items:
    if x + img.width > WIDTH:
        x = 0; y += row_h + 1; row_h = 0
    frames[name] = {"x": x, "y": y, "w": img.width, "h": img.height}
    x += img.width + 1; row_h = max(row_h, img.height)
atlas = Image.new("RGBA", (WIDTH, y + row_h), (0, 0, 0, 0))
for name, img in items:
    f = frames[name]; atlas.alpha_composite(img, (f["x"], f["y"]))
atlas.save(OUT / "sprites.png", optimize=True)

# ---------------------------------------------------------------- the office as the toy starts (for no-JS and first paint)
def sprite(name):
    f = frames[name]
    return atlas.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))

CELL = 24
SPECIES = ["bun", "bot", "shield", "ghost", "cat", "manager", "mini", "notetaker", "mailclerk"]
NAME_OF = {v: k for k, v in COLOURS.items()}
TAIL = {"bun": 4, "bot": 6, "shield": 4, "ghost": 4, "cat": 3, "manager": 0, "mini": 10}

def critter(colour, species, frame=0):
    sheet = sprite(f"critters-{NAME_OF[colour.lower()]}")
    row = SPECIES.index(species)
    return sheet.crop((frame * CELL, row * CELL, frame * CELL + CELL, row * CELL + CELL))

still = world.copy()
def put(img, mx, my):
    still.alpha_composite(img, (mx - WORLD["x"], my - WORLD["y"])) if 0 <= mx - WORLD["x"] and 0 <= my - WORLD["y"] else None

furnished = [k for k in o5["order"] if k not in ("elm",) and not k.startswith("lot")]
draw = []
for p in o5["props"]:
    if p["room"] == "elm":
        continue
    draw.append((p["sortY"], 0, lambda p=p: put(sprite(f"furniture/{p['kind']}"), p["x"], p["y"])))
for d in o5["desks"]:
    if d["room"] == "elm":
        continue
    colour = o5["room"][d["room"]]["palette"]["base"]
    glow = d["glow"]
    scr = f"screens/work-{NAME_OF[colour.lower()]}" if glow == "work" else f"screens/{glow}"
    def desk(d=d, scr=scr):
        put(sprite("furniture/desk"), d["desk"]["x"], d["desk"]["y"])
        put(sprite("furniture/monitor"), d["desk"]["x"] + 30, d["desk"]["y"] - 9)
        put(sprite(scr), d["desk"]["x"] + 31, d["desk"]["y"] - 8)
    draw.append((d["desk"]["y"] + 18, 1, desk))
actors = [a for a in o5["actors"] if a["room"] != "elm"] + [o5["luady"]]
for a in actors:
    draw.append((a["y"], 2, lambda a=a: put(critter(a["colour"], a["species"]), a["x"] - 12, a["y"] + 1 - CELL)))
for _, _, fn in sorted(draw, key=lambda t: (t[0], t[1])):
    fn()
for a in actors:
    if a.get("bubble"):
        put(sprite(f"bubbles/{a['bubble']}"), a["x"] + 3, a["y"] - 23 + TAIL[a["species"]] - 14)
# The first view: the left half of the office (the empty lot, Cedar and HQ, the top of Ash).
VIEW = {"x": 0, "y": 0, "w": 1344, "h": 456}
still.crop((VIEW["x"] - WORLD["x"], VIEW["y"] - WORLD["y"], VIEW["x"] - WORLD["x"] + VIEW["w"], VIEW["y"] - WORLD["y"] + VIEW["h"])).save(OUT / "office-still.png", optimize=True)

# ---------------------------------------------------------------- the manifest the site reads
rooms = {}
for k in o5["order"]:
    r = o5["room"][k]
    rooms[k] = {"id": r["id"], "name": r["name"], "kind": r["kind"], "rect": r["rect"], "doorway": r["doorway"],
                "palette": r["palette"], "species": r["species"], "side": r["side"], "lot": r["name"] == "Vacant" or k == "elm"}
manifest = {
    "about": "Pixel art of the Luady office, exported from the product's own drawing code (packages/office). See site/scripts/export-pixel-art.md.",
    "cell": CELL, "species": SPECIES, "frames": ["idle", "blink", "step"], "tail": TAIL,
    "colours": COLOURS,
    "world": {"file": "office-world.png", **WORLD},
    "still": {"file": "office-still.png", **VIEW},
    "sprites": {"file": "sprites.png", "frames": frames},
    "rooms": {"file": "rooms.png", "frames": rooms_frames},
    "office": {
        "width": o5["width"], "height": o5["height"], "hq": o5["hq"], "luadySit": o5["luadySit"], "zones": o5["zones"],
        "rooms": rooms,
        "props": [{"kind": p["kind"], "x": p["x"], "y": p["y"], "sortY": p["sortY"], "room": p["room"]} for p in o5["props"] if p["room"] != "elm"],
        "desks": [{"room": d["room"], "desk": d["desk"], "sit": d["sit"]} for d in o5["desks"] if d["room"] != "elm"],
        "actors": [{"id": a["id"], "room": a["room"], "seat": a["seat"], "x": a["x"], "y": a["y"], "species": a["species"],
                    "colour": a["colour"], "state": a["state"], "bubble": a["bubble"], "label": a["label"]} for a in o5["actors"] if a["room"] != "elm"],
        "luady": o5["luady"],
        "lamps": [[lx - M, ly - M] for lx, ly in o5["lamps"]],
        "builds": builds,
    },
}
(OUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
for f in sorted(OUT.iterdir()):
    print(f.name, f.stat().st_size)
print("atlas", atlas.size, "rooms", rooms_img.size, "world", world.size)
