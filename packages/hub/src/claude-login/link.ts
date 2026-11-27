/** Where a Claude sign-in link may point: the provider's own sites and their subdomains. */
export const PROVIDER_HOSTS: readonly string[] = ['claude.ai', 'claude.com', 'anthropic.com'];

/**
 * A sign-in link is shown only when it is https, has no user or password part, and its host is the provider's (not
 * `claude.ai.evil.example`, not `claude.ai:login@evil.example`, not a path that merely mentions `claude.ai`).
 */
export function isProviderLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase();
  return PROVIDER_HOSTS.some((provider) => host === provider || host.endsWith(`.${provider}`));
}
