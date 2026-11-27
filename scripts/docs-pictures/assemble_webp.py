"""Builds the animated office-demo.webp from the frames capture.mjs took (Python 3 with Pillow).

    python scripts/docs-pictures/assemble_webp.py <frames folder> <out.webp>

The frames folder holds frames.json (a list of {"file": ..., "ms": ...}: each frame and how long it stays) and the
PNG frames. The last frame fades into the first one, so the loop has no jump. The quality is the highest whose file
stays under the target size (about the size of the earlier animation); the file is never over the limit.
"""
import io
import json
import sys
from pathlib import Path

from PIL import Image

SIZE = (800, 500)
FADE_STEPS = 6
FADE_STEP_MS = 80
TARGET_BYTES = 1_450_000
LIMIT_BYTES = 2_000_000
QUALITY_LOW, QUALITY_HIGH = 30, 92


def load_frames(folder):
    """The frames in order, each as an RGB picture with its duration in milliseconds."""
    listing = json.loads((folder / 'frames.json').read_text(encoding='utf-8'))
    frames = []
    for entry in listing:
        picture = Image.open(folder / entry['file']).convert('RGB')
        if picture.size != SIZE:
            raise SystemExit(f"{entry['file']} is {picture.size}, not {SIZE}")
        frames.append((picture, int(entry['ms'])))
    if len(frames) < 2:
        raise SystemExit('fewer than two frames')
    return frames


def with_fade(frames):
    """The frames, then a short cross-fade from the last picture to the first one."""
    first, last = frames[0][0], frames[-1][0]
    fade = [(Image.blend(last, first, step / (FADE_STEPS + 1)), FADE_STEP_MS) for step in range(1, FADE_STEPS + 1)]
    return frames + fade


def encode(frames, quality):
    """The animated WebP (looping for ever) at one quality, as bytes."""
    out = io.BytesIO()
    pictures = [picture for picture, _ in frames]
    pictures[0].save(out, format='WEBP', save_all=True, append_images=pictures[1:], duration=[ms for _, ms in frames],
                     loop=0, quality=quality, method=4)
    return out.getvalue()


def best_quality(frames):
    """The highest quality whose file is at most TARGET_BYTES (bisection on whole numbers)."""
    low, high, best = QUALITY_LOW, QUALITY_HIGH, None
    while low <= high:
        quality = (low + high) // 2
        data = encode(frames, quality)
        print(f'  quality {quality}: {len(data) / 1e6:.2f} MB')
        if len(data) <= TARGET_BYTES:
            best, low = (quality, data), quality + 1
        else:
            high = quality - 1
    if best is None:
        raise SystemExit(f'even quality {QUALITY_LOW} is over {TARGET_BYTES} bytes')
    return best


def check(path, expected_frames):
    """Opens the written file again: size, frame count, length and loop."""
    data = path.read_bytes()
    if len(data) > LIMIT_BYTES:
        raise SystemExit(f'{path.name} is {len(data)} bytes, over {LIMIT_BYTES}')
    with Image.open(path) as anim:
        total = 0
        for index in range(anim.n_frames):
            anim.seek(index)
            anim.load()
            total += anim.info.get('duration', 0)
        if anim.size != SIZE or anim.n_frames != expected_frames or anim.info.get('loop') != 0:
            raise SystemExit(f'{path.name}: {anim.size}, {anim.n_frames} frames, loop {anim.info.get("loop")}')
        print(f'  wrote {path.name}: {anim.n_frames} frames, {total / 1000:.2f} s, {len(data) / 1e6:.2f} MB, loops for ever')


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    folder, out = Path(sys.argv[1]), Path(sys.argv[2])
    frames = with_fade(load_frames(folder))
    quality, data = best_quality(frames)
    out.write_bytes(data)
    print(f'  quality {quality}')
    check(out, len(frames))


if __name__ == '__main__':
    main()
