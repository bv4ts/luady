import type { Palette } from '@luady/office';
import type { ReactNode } from 'react';
import { teamStyle } from '../model/team-style.js';

/** The coloured band at the top of a panel, in the room's colours. */
export function PanelHead({ title, palette, children }: { title: string; palette: Palette; children?: ReactNode }) {
  return (
    <header className="agency-panel__head" style={teamStyle(palette)}>
      <h2 className="agency-panel__title" dir="auto">{title}</h2>
      {children ? <div className="agency-panel__sub">{children}</div> : null}
    </header>
  );
}
