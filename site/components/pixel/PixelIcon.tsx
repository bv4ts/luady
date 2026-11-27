'use client';

import { useEffect, useRef } from 'react';
import { MANIFEST, deviceScale, loadKit, pixelContext, sprite } from './kit';

/**
 * One sprite from the product's atlas (a bubble icon, a piece of furniture) at a whole-number scale. Decorative: it is
 * hidden from screen readers, and the text next to it says what it means.
 */
export function PixelIcon({ name, scale = 3, className }: { name: string; scale?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = MANIFEST.sprites.frames[name];
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null || frame === undefined) return;
    let alive = true;
    void loadKit().then((kit) => {
      if (!alive) return;
      const k = deviceScale(scale);
      const dpr = window.devicePixelRatio || 1;
      // Whole screen pixels per art pixel: the CSS size follows the canvas, so nothing is resampled.
      canvas.style.width = `${(frame.w * k) / dpr}px`;
      canvas.style.height = `${(frame.h * k) / dpr}px`;
      canvas.width = frame.w * k;
      canvas.height = frame.h * k;
      const ctx = pixelContext(canvas);
      if (ctx === null) return;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      sprite(ctx, kit, name, 0, 0);
    });
    return () => {
      alive = false;
    };
  }, [name, scale, frame]);
  if (frame === undefined) return null;
  return <canvas ref={ref} className={className} width={frame.w * scale} height={frame.h * scale} aria-hidden="true" data-scale={scale} />;
}
