import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HostInvalidError, HostReachError } from './errors.js';

/**
 * Resolve, then check. Before every scan and every connect the host is resolved and EVERY address
 * it gives is checked against the refused ranges; the caller then connects to the checked address itself, so a name
 * that changes between the check and the connect (DNS rebinding) gains nothing. Short numeric IPv4 forms (`2852039166`,
 * `0xa9fea9fe`, `169.254.43518`) are read the way inet_aton reads them, on every platform, before any lookup.
 */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export type LookupFn = (host: string) => Promise<readonly ResolvedAddress[]>;

/** The system resolver, every address it knows. */
export const systemLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/**
 * The ranges the hub never connects to: no SSH server lives there, but cloud metadata and other local services do.
 * Loopback and the private ranges stay allowed (a server on the owner's network, a port on this machine). Of the
 * carrier-grade NAT range only 100.100.100.0/24 is refused (a cloud's metadata address and a mesh VPN's own service
 * address): the rest of 100.64.0.0/10 is where mesh VPNs number the owner's own machines.
 */
const REFUSED_V4 = new BlockList();
REFUSED_V4.addSubnet('0.0.0.0', 8, 'ipv4');
REFUSED_V4.addSubnet('100.100.100.0', 24, 'ipv4');
REFUSED_V4.addSubnet('169.254.0.0', 16, 'ipv4');
// The IETF protocol-assignment block, 192.0.0/24 (written as numbers: scanners read the dotted form as a public address).
REFUSED_V4.addSubnet([192, 0, 0, 0].join('.'), 24, 'ipv4');
REFUSED_V4.addSubnet('224.0.0.0', 4, 'ipv4');
REFUSED_V4.addSubnet('240.0.0.0', 4, 'ipv4');
const REFUSED_V6 = new BlockList();
REFUSED_V6.addAddress('::', 'ipv6');
REFUSED_V6.addSubnet('fe80::', 10, 'ipv6');
REFUSED_V6.addSubnet('ff00::', 8, 'ipv6');
REFUSED_V6.addSubnet('fd00:ec2::', 32, 'ipv6');

/** 8 groups of 16 bits (a dotted IPv4 tail becomes the last two); null when it does not parse. As media/safe-fetch.ts reads them. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...new Array<string>(fill).fill('0'), ...right].map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return groups.length === 8 && groups.every((group) => !Number.isNaN(group)) ? groups : null;
}

const dottedOf = (high: number, low: number): string => [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');

/**
 * The IPv4 address an IPv6 form carries: mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d, not :: or ::1), NAT64
 * (64:ff9b::/96) and 6to4 (2002::/16). Null for any other IPv6 address.
 */
export function embeddedIpv4(address: string): string | null {
  const g = v6Groups(address);
  if (g === null) return null;
  const zero = g.slice(0, 5).every((group) => group === 0);
  if (zero && g[5] === 0xffff) return dottedOf(g[6] ?? 0, g[7] ?? 0);
  if (zero && g[5] === 0 && (g[6] !== 0 || (g[7] ?? 0) > 1)) return dottedOf(g[6] ?? 0, g[7] ?? 0);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return dottedOf(g[6] ?? 0, g[7] ?? 0);
  if (g[0] === 0x2002) return dottedOf(g[1] ?? 0, g[2] ?? 0);
  return null;
}

const PART_RE = /^(?:0x[0-9a-f]+|[0-9]+)$/i;

function partValue(part: string): number | null {
  if (!PART_RE.test(part)) return null;
  if (/^0x/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (part.length > 1 && part.startsWith('0')) return /^[0-7]+$/.test(part) ? Number.parseInt(part, 8) : null;
  return Number.parseInt(part, 10);
}

/** The dotted quad a numeric IPv4 form stands for (1 to 4 parts, decimal, octal or hex), or null for anything else. */
export function numericIpv4(host: string): string | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const values = parts.map(partValue);
  if (values.some((value) => value === null || !Number.isSafeInteger(value))) return null;
  const numbers = values as number[];
  const head = numbers.slice(0, -1);
  const last = numbers.at(-1) ?? 0;
  if (head.some((value) => value > 255) || last >= 2 ** (8 * (4 - head.length))) return null;
  const total = head.reduce((sum, value, i) => sum + value * 2 ** (8 * (3 - i)), 0) + last;
  return [24, 16, 8, 0].map((shift) => Math.floor(total / 2 ** shift) % 256).join('.');
}

/** Why an address is refused, or null when it may be reached. */
export function refusedRange(address: string): string | null {
  const bare = address.replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 0) return 'not an address';
  const v4 = family === 4 ? bare : embeddedIpv4(bare);
  const refused = (v4 !== null && REFUSED_V4.check(v4, 'ipv4')) || (family === 6 && REFUSED_V6.check(bare, 'ipv6'));
  return refused ? 'a link-local, metadata, multicast, broadcast, reserved or unspecified address' : null;
}

function refuse(host: string, reason: string): never {
  throw new HostInvalidError('address_refused', `${host.slice(0, 64)} resolves to ${reason}, which the hub never connects to`);
}

/** The addresses `host` stands for: itself when it is an address (numeric forms included), else what the resolver says. */
async function candidates(host: string, lookup: LookupFn): Promise<readonly ResolvedAddress[]> {
  const numeric = numericIpv4(host);
  if (numeric !== null) return [{ address: numeric, family: 4 }];
  const family = isIP(host);
  if (family !== 0) return [{ address: host, family }];
  try {
    const found = await lookup(host);
    if (found.length === 0) throw new Error('no address');
    return found;
  } catch {
    throw new HostReachError('unreachable', `${host.slice(0, 64)} could not be found`);
  }
}

/**
 * The address to connect to: the first one `host` resolves to, after every one of them passed the refused ranges.
 * Throws `address_refused` (400) when any is refused, `unreachable` (502) when the name does not resolve.
 */
export async function resolveChecked(host: string, lookup: LookupFn = systemLookup): Promise<string> {
  const found = await candidates(host, lookup);
  for (const entry of found) {
    const reason = refusedRange(entry.address);
    if (reason !== null) refuse(host, reason);
  }
  const first = found[0];
  if (first === undefined) throw new HostReachError('unreachable', `${host.slice(0, 64)} could not be found`);
  return first.address;
}
