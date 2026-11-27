import type { ReactNode } from 'react';

export type RoomColour = 'rose' | 'cyan' | 'violet' | 'orange' | 'moss' | 'mute' | 'lamp' | 'teal';

/**
 * A section of the landing page drawn as a room of the office: a frame along its top in the room's colour, and its
 * heading as the room's name plate hung on that frame.
 */
export function Room({ id, colour, title, lead, children }: {
  id: string; colour: RoomColour; title: string; lead?: ReactNode; children: ReactNode;
}) {
  return (
    <section className={`room room--${colour}`} id={id} aria-labelledby={`${id}-title`} data-assemble="">
      <div className="wrap">
        <header className="room__head">
          <h2 className="plate" id={`${id}-title`}>{title}</h2>
          {lead === undefined ? null : <p className="room__lead">{lead}</p>}
        </header>
        {children}
      </div>
    </section>
  );
}
