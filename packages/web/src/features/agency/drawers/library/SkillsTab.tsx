import type { LibraryDTO, SkillDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { useStore } from '../../../../state/store.js';
import { Icon } from '../../../../ui/Icon.js';
import { hqName, useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { whenText } from '../account-text.js';
import { libraryError } from './library-error.js';
import { filterSkills, groupSkills, officeName, officePalette } from './library-model.js';
import { managerName } from '@luady/shared';

/** What an office shows when its kit cannot list skills (older than 2.1, or it has not answered). */
export const KIT_TOO_OLD = 'Update the kit on this server to list its skills.';

/** The skills of every office, grouped as yours, project and plug-in, with Luady's own first. */
export function SkillsTab({ library }: { library: LibraryDTO }) {
  const api = useApi();
  const { toast } = useStore();
  const lookup = useRooms();
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const filterId = useId();

  async function refresh() {
    setBusy(true);
    try {
      await api.refreshLibrary();
      toast('success', 'Asking every server for its skills.');
    } catch (err) {
      toast('error', libraryError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lib-skills">
      <div className="lib-kb__bar">
        <label className="lib-search" htmlFor={filterId}>
          <span className="lib-visually-hidden">Find a skill</span>
          <input id={filterId} type="search" className="lib-input lib-search__input" placeholder="Find a skill" value={filter}
            onChange={(event) => setFilter(event.target.value)} />
        </label>
        <button type="button" className="lib-btn lib-btn--quiet" disabled={busy} onClick={() => void refresh()}>
          <Icon name="restart" /> {busy ? 'Asking…' : 'Ask the servers again'}
        </button>
      </div>
      <SkillDrawer title={managerName()} note={`His own skills in ${hqName()}`} skills={filterSkills(library.managerSkills, filter)} server={null} flat />
      {library.offices.map((office) => (
        <SkillDrawer key={office.server} title={officeName(office.server, lookup)} server={office.server}
          note={office.skillsAt === null ? null : `Listed ${whenText(office.skillsAt, new Date())}`}
          skills={office.skills === null ? null : filterSkills(office.skills, filter)} />
      ))}
    </div>
  );
}

function SkillDrawer({ title, note, skills, server, flat = false }: {
  title: string; note: string | null; skills: readonly SkillDTO[] | null; server: string | null; flat?: boolean;
}) {
  const lookup = useRooms();
  const style = server === null ? undefined : teamStyle(officePalette(server, lookup));
  return (
    <section className="lib-drawer" style={style} aria-label={`${title} skills`} data-testid={`skills-${server ?? 'manager'}`}>
      <h3 className="lib-drawer__head">
        <span className="lib-office__plate">{title}</span>
        {note === null ? null : <span className="lib-shelf__hint">{note}</span>}
      </h3>
      {skills === null ? <p className="lib-drawer__old">{KIT_TOO_OLD}</p>
        : skills.length === 0 ? <p className="lib__quiet">No skills here.</p>
          : flat ? <SkillCards skills={skills.toSorted((a, b) => a.name.localeCompare(b.name))} />
            : groupSkills(skills).map((group) => (
              <div key={group.source} className="lib-drawer__group">
                <h4 className="lib-drawer__group-name">{group.label} <span className="lib-shelf__hint">{group.skills.length}</span></h4>
                <SkillCards skills={group.skills} />
              </div>
            ))}
    </section>
  );
}

function SkillCards({ skills }: { skills: readonly SkillDTO[] }) {
  return (
    <ul className="lib-cards">
      {skills.map((skill) => (
        <li key={`${skill.source}:${skill.path}:${skill.name}`} className="lib-card">
          <span className="lib-card__name">{skill.name}</span>
          <span className="lib-card__desc" dir="auto">{skill.description}</span>
        </li>
      ))}
    </ul>
  );
}
