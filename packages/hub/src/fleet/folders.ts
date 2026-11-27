import { posix } from 'node:path';

/** The usual home of a Unix user on a host whose row names none: `/root` for root, `/home/<user>` for anyone else. */
export function homeOf(user: string): string {
  return user === 'root' ? '/root' : posix.join('/home', user);
}

/** What a host's row says about its folders. */
export interface HostFolders {
  readonly projectsRoot: string | null;
  readonly homeDir: string | null;
  readonly user: string;
}

/**
 * Where sessions start on a host: its row's projects folder, else `projects` in its home (the row's home, else the
 * user's usual one), the folder the kit itself uses when it is installed without one.
 */
export function projectsFolderOf(host: HostFolders): string {
  return host.projectsRoot ?? posix.join(host.homeDir ?? homeOf(host.user), 'projects');
}

/** A host's home: its row's, else the user's usual one. */
export function homeFolderOf(host: Pick<HostFolders, 'homeDir' | 'user'>): string {
  return host.homeDir ?? homeOf(host.user);
}
