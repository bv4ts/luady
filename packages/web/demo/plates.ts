import type { AgencySnapshot } from '@luady/office';
import type { OverlayPoint } from '../src/features/agency/stage-types.js';

/** Bare name labels hung from each point's footY, to see the overlay points line up (the real ones are the page's job). */
export function createPlates(layer: HTMLElement): { place(points: readonly OverlayPoint[], snapshot: AgencySnapshot | null): void; clear(): void } {
  const nodes = new Map<string, HTMLElement>();

  const nodeFor = (id: string): HTMLElement => {
    const known = nodes.get(id);
    if (known !== undefined) return known;
    const node = document.createElement('div');
    node.className = 'demo-plate';
    layer.appendChild(node);
    nodes.set(id, node);
    return node;
  };

  return {
    place: (points, snapshot) => {
      const seen = new Set(points.map((p) => p.id));
      nodes.forEach((node, id) => {
        if (seen.has(id)) return;
        node.remove();
        nodes.delete(id);
      });
      points.forEach((p) => {
        const node = nodeFor(p.id);
        const actor = snapshot?.actors[p.id];
        node.textContent = actor?.name ?? (p.id === 'manager' ? 'Luady' : p.id);
        node.classList.toggle('needs', actor?.visual.needsOwner === true);
        // Like the page: agent labels only where the desks leave room for a readable name; Luady always.
        node.hidden = !p.visible || (p.id !== 'manager' && p.maxWidth < 56);
        node.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.footY)}px, 0) translate(-50%, 0)`;
        node.style.maxWidth = `${Math.max(40, Math.floor(p.maxWidth))}px`;
      });
    },
    clear: () => {
      nodes.forEach((node) => node.remove());
      nodes.clear();
    },
  };
}
