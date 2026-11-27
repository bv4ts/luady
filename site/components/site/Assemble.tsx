'use client';

import { useEffect } from 'react';

/** Starts each section's frame animation as the section comes into view (see `.room[data-assemble]` in globals.css). */
export function Assemble() {
  useEffect(() => {
    const rooms = [...document.querySelectorAll<HTMLElement>('[data-assemble]')];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.assemble = 'in';
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.15 });
    for (const room of rooms) observer.observe(room);
    return () => observer.disconnect();
  }, []);
  return null;
}
