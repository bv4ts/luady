// The docs pictures: each file's size in pixels, and a writer that refuses a picture of another size.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Every picture this tool makes, with the size the pages show it at (README, docs, website). Not here:
 * feature-addons.png (kept as it is, see README.md) and how-it-works.svg (a drawing).
 */
export const PICTURES = Object.freeze({
  'setup-claim.png': [880, 560],
  'setup-pin.png': [880, 560],
  'setup-rooms.png': [880, 560],
  'setup-open.png': [880, 605],
  'settings.png': [1440, 900],
  'add-server-details.png': [450, 653],
  'pin-confirm.png': [450, 416],
  'add-server-key-line.png': [450, 588],
  'phone.png': [780, 1688],
  'room-editor.png': [1440, 900],
  'feature-rooms.png': [800, 500],
  'room-panel.png': [1440, 900],
  'office.png': [1440, 900],
  'rooms-menu.png': [1440, 900],
  'feature-servers.png': [800, 500],
  'feature-manager.png': [800, 500],
  'office-demo.webp': [800, 500],
});

/** Width and height of a PNG, read from its header. */
export function pngSize(bytes) {
  const signature = bytes.subarray(1, 4).toString('ascii');
  if (signature !== 'PNG') throw new Error('not a PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** Which pictures to make: all, or the ones named with --only (the animation is "office-demo.webp"). */
export function wanted(only) {
  return (name) => only === null || only.includes(name);
}

/**
 * Writes a PNG into ctx.outDir after checking it has the size the pages expect; says what it wrote. With --any-size
 * (ctx.anySize) a picture of another size is written too, with a warning: the page it shows has changed, and the pages
 * that show the picture may need their sizes changed.
 */
export async function savePng(ctx, name, bytes) {
  const expected = PICTURES[name];
  if (expected === undefined) throw new Error(`${name} is not one of the docs pictures`);
  const [width, height] = pngSize(bytes);
  if (width !== expected[0] || height !== expected[1]) {
    const problem = `${name} came out ${width}x${height}, the pages expect ${expected[0]}x${expected[1]}`;
    if (!ctx.anySize) throw new Error(problem);
    console.warn(`  WARNING: ${problem}`);
  }
  const path = `${ctx.outDir}/${name}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  console.log(`  wrote ${name} (${width}x${height}, ${Math.round(bytes.length / 1024)} KB)`);
}
