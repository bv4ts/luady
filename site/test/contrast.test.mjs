/** Every text colour of the site meets WCAG AA (4.5:1) on each surface it is used on, from the tokens in globals.css. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** WCAG relative luminance and contrast of two #rrggbb colours. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(join(SITE, 'app', 'globals.css'), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((match) => [match[1], match[2]]));

/** [text, surface] pairs as the pages use them. */
const PAIRS = [
  // body text, headings and quiet text on the page, the bands, panels, cards and code
  ...['text', 'cream', 'dim', 'subtle'].flatMap((fg) => ['night', 'night-2', 'dusk', 'dusk-2', 'deep'].map((bg) => [fg, bg])),
  // links and the teal accents
  ['teal', 'night'], ['teal', 'night-2'], ['teal', 'dusk'], ['teal', 'dusk-2'], ['teal', 'deep'], ['teal-hi', 'dusk'], ['teal-hi', 'night'],
  // dark text on the teal buttons; code; the lamp-coloured headings of the menu and the warning
  ['ink', 'teal'], ['ink', 'teal-hi'], ['code', 'deep'], ['lamp', 'night'], ['lamp', 'dusk'], ['lamp-soft', 'night'],
  ['warn-text', 'warn-bg'], ['lamp', 'warn-bg'], ['lamp', 'badge-bg'],
  // the toy's labels and the question card, the deny button
  ['cream', 'label-bg'], ['dim', 'label-bg'], ['red-soft', 'dusk'], ['red', 'dusk'],
];

test('text colours meet WCAG AA on the surfaces they sit on', () => {
  for (const [fg, bg] of PAIRS) {
    assert.ok(tokens[fg] && tokens[bg], `--${fg} and --${bg} are defined in globals.css`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    assert.ok(ratio >= 4.5, `--${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test('the brand colours are the site\'s', () => {
  assert.equal(tokens.night, '#0c1328');
  assert.equal(tokens.dusk, '#1b1731');
  assert.equal(tokens.teal, '#3cc3b0');
  assert.equal(tokens.lamp, '#ffd84d');
});
