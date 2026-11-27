import type { LibraryDTO, LibraryOfficeDTO, LibraryProjectDTO } from '@luady/shared';
import { useState } from 'react';
import { useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { whenText } from '../account-text.js';
import { officeName, officePalette, projectCounts, shortFolder } from './library-model.js';
import { ProjectDetail } from './ProjectDetail.js';
import { useProjectsRoot } from './useProjectsRoot.js';

/** Projects grouped by office; one opens to its pages and sessions. */
export function ProjectsTab({ library }: { library: LibraryDTO }) {
  const [open, setOpen] = useState<LibraryProjectDTO | null>(null);
  if (open !== null) {
    // The open project follows live library updates (counts), and closes if it is gone.
    const fresh = library.offices.find((office) => office.server === open.server)?.projects.find((p) => p.path === open.path) ?? open;
    return <ProjectDetail project={fresh} onBack={() => setOpen(null)} />;
  }
  if (library.offices.length === 0) {
    return <p className="lib__quiet">No offices yet. Projects show up here once a server reports its project folders.</p>;
  }
  return (
    <div className="lib-offices">
      {library.offices.map((office) => <OfficeShelf key={office.server} office={office} onOpen={setOpen} />)}
    </div>
  );
}

function OfficeShelf({ office, onOpen }: { office: LibraryOfficeDTO; onOpen: (project: LibraryProjectDTO) => void }) {
  const lookup = useRooms();
  const root = useProjectsRoot(office.server);
  const name = officeName(office.server, lookup);
  return (
    <section className="lib-office" style={teamStyle(officePalette(office.server, lookup))} aria-label={name} data-testid={`office-${office.server}`}>
      <h3 className="lib-office__name">
        <span className="lib-office__plate">{name}</span>
        <span className="lib-office__count">{office.projects.length} {office.projects.length === 1 ? 'project' : 'projects'}</span>
      </h3>
      {office.projects.length === 0 ? <p className="lib__quiet">No projects found on this server.</p> : (
        <ul className="lib-projects">
          {office.projects.map((project) => (
            <li key={project.path}><ProjectCard project={project} root={root} onOpen={() => onOpen(project)} /></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectCard({ project, root, onOpen }: { project: LibraryProjectDTO; root: string | null; onOpen: () => void }) {
  const last = project.commits[0];
  return (
    <button type="button" className="lib-project" onClick={onOpen} aria-label={`Open ${project.name}`}>
      <span className="lib-project__name" dir="auto">{project.name}</span>
      <span className="lib-project__folder">{shortFolder(project.path, root)}{project.branch === null ? '' : ` · ${project.branch}`}</span>
      {last === undefined ? null : (
        <span className="lib-project__commit" dir="auto">
          <span className="lib-project__hash">{last.hash.slice(0, 7)}</span> {last.subject}
          <span className="lib-project__when"> · {whenText(last.date, new Date())}</span>
        </span>
      )}
      {project.stack.length === 0 ? null : (
        <span className="lib-project__stack">{project.stack.slice(0, 5).map((item) => <span key={item} className="lib-chip">{item}</span>)}</span>
      )}
      <span className="lib-project__counts">{projectCounts(project)}</span>
    </button>
  );
}
