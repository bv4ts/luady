import { vi, type Mock } from 'vitest';
import type { ChannelsApi } from '../../src/api/channels.js';
import { createApiClient, type LuadyApi } from '../../src/api/client.js';
import type { HostsApi } from '../../src/api/hosts.js';

type Routes = Omit<LuadyApi, 'hosts' | 'channels'>;
type Mocked<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? Mock<T[K]> : never };
export type FakeHostsApi = Mocked<HostsApi>;
export type FakeChannelsApi = Mocked<ChannelsApi>;
export type FakeApi = Mocked<Routes> & { hosts: FakeHostsApi; channels: FakeChannelsApi };
export type FakeApiOverrides = { [K in keyof Routes]?: Routes[K] } & { hosts?: Partial<HostsApi>; channels?: Partial<ChannelsApi> };

const notMocked = (key: string) => (..._args: unknown[]) => Promise.reject(new Error(`fakeApi: ${key} is not mocked`));

/** One vi.fn per route of a group: the override when given, else `fallback(name)`. */
function mockGroup<T extends object>(template: T, overrides: Partial<T> | undefined, prefix: string,
  fallback: (key: string) => (...args: unknown[]) => unknown = notMocked): Mocked<T> {
  return Object.fromEntries((Object.keys(template) as Array<keyof T & string>).map((key) =>
    [key, vi.fn((overrides?.[key] as ((...args: never[]) => unknown) | undefined) ?? fallback(`${prefix}${key}`))] as const)) as unknown as Mocked<T>;
}

/**
 * Every route is a vi.fn that rejects with "not mocked" unless overridden; so is every route of the nested `hosts` and
 * `channels` groups. `csrf` is the one synchronous member of the client, so its default returns null instead of a
 * rejected promise.
 */
export function fakeApi(overrides: FakeApiOverrides = {}): FakeApi {
  const template = createApiClient({ fetch: () => Promise.reject(new Error('fakeApi: unexpected fetch')) });
  const { hosts: hostsTemplate, channels: channelsTemplate, ...routes } = template;
  const { hosts: hostOverrides, channels: channelOverrides, ...routeOverrides } = overrides;
  const top = mockGroup<Routes>(routes, routeOverrides as Partial<Routes>, '', (key) => (key === 'csrf' ? () => null : notMocked(key)));
  return { ...top, hosts: mockGroup(hostsTemplate, hostOverrides, 'hosts.'), channels: mockGroup(channelsTemplate, channelOverrides, 'channels.') };
}
