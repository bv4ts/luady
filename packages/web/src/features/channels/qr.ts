import { create } from 'qrcode';

export interface QrStyle {
  readonly scale: number;
  readonly margin: number;
  readonly dark: string;
  readonly light: string;
}

/** Always dark on light, so it scans in dark mode too. */
export const QR_STYLE: QrStyle = { scale: 6, margin: 4, dark: '#111417', light: '#ffffff' };

export function qrMatrix(text: string): boolean[][] {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  return Array.from({ length: modules.size }, (_, row) =>
    Array.from({ length: modules.size }, (_unused, col) => Boolean(modules.get(row, col))));
}

/** Draws with canvas calls only; size comes from CSS classes, never from inline styles. */
export function drawQr(canvas: HTMLCanvasElement, matrix: readonly (readonly boolean[])[], style: QrStyle = QR_STYLE): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D drawing is not available in this browser');
  const size = (matrix.length + style.margin * 2) * style.scale;
  canvas.width = size;
  canvas.height = size;
  context.fillStyle = style.light;
  context.fillRect(0, 0, size, size);
  context.fillStyle = style.dark;
  matrix.forEach((row, r) => row.forEach((on, c) => {
    if (on) context.fillRect((c + style.margin) * style.scale, (r + style.margin) * style.scale, style.scale, style.scale);
  }));
}
