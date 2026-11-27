'use client';

import { useEffect, useRef } from 'react';
import { bubble, critter, deviceScale, loadKit, pixelContext, roomInside } from '../pixel/kit';
import { prefersReducedMotion, runWhileVisible } from '../pixel/motion';

const VIEW = { w: 200, h: 112 };
/** Where the view starts inside the empty lot's picture (420 x 276, frame included): its back wall at the top. */
const O = { x: 110, y: 0 };

/**
 * The 404 page's picture: an empty lot where a page should be, and a creature walking up and down it looking for it
 * (the product's search bubble over its head). Decorative; with reduced motion it stands still.
 */
export function LostScene() {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (box === null || canvas === null) return undefined;
    const ctx = pixelContext(canvas);
    if (ctx === null) return undefined;
    let alive = true;
    let stop = () => {};
    const still = prefersReducedMotion();
    const start = performance.now();
    void loadKit().then((kit) => {
      if (!alive) return;
      const k = deviceScale(box.clientWidth >= 560 ? 3 : 2);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = VIEW.w * k;
      canvas.height = VIEW.h * k;
      canvas.style.width = `${(VIEW.w * k) / dpr}px`;
      canvas.style.height = `${(VIEW.h * k) / dpr}px`;
      const frame = (now: number) => {
        const t = still ? 0 : now - start;
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.imageSmoothingEnabled = false;
        roomInside(ctx, kit, 'lot', -O.x, -O.y);
        // Walks left and right across the lot, pausing at each end to look around.
        const leg = (t % 9000) / 9000;
        const along = leg < 0.4 ? leg / 0.4 : leg < 0.5 ? 1 : leg < 0.9 ? 1 - (leg - 0.5) / 0.4 : 0;
        const walking = (leg < 0.4 || (leg >= 0.5 && leg < 0.9)) && !still;
        const x = Math.round(40 + along * 120);
        const step = walking && Math.floor(t / 150) % 2 === 1;
        critter(ctx, kit, '#a78bfa', 'cat', step ? 'step' : 'idle', x, 82 - (step ? 1 : 0));
        bubble(ctx, kit, walking ? 'search' : 'ask', 'cat', x, 82);
      };
      box.dataset.live = '';
      if (still) frame(performance.now());
      else {
        const loop = runWhileVisible(box, frame, 24);
        stop = () => loop.stop();
      }
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return (
    <div className="lost" ref={boxRef} aria-hidden="true">
      <canvas ref={canvasRef} width={VIEW.w * 2} height={VIEW.h * 2} />
    </div>
  );
}
