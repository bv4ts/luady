import { readFileSync } from 'node:fs';

/**
 * The pixel size of a PNG, WebP or SVG file, read from its header, so pages can give every picture a width and a height
 * and nothing moves while it loads. Returns null for anything it cannot read.
 */
export function imageSize(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  return pngSize(bytes) ?? webpSize(bytes) ?? svgSize(bytes);
}

function pngSize(b) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((byte, i) => b[i] === byte)) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function webpSize(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function svgSize(b) {
  const head = b.toString('utf8', 0, Math.min(b.length, 2048));
  const tag = /<svg\b[^>]*>/.exec(head)?.[0];
  if (tag === undefined) return null;
  const width = /\swidth="(\d+(?:\.\d+)?)"/.exec(tag)?.[1];
  const height = /\sheight="(\d+(?:\.\d+)?)"/.exec(tag)?.[1];
  if (width !== undefined && height !== undefined) return { width: Math.round(Number(width)), height: Math.round(Number(height)) };
  const box = /\sviewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(tag);
  return box === null ? null : { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) };
}
