import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSshExecutor } from '../../src/fleet/ssh-executor.js';
import { embeddedIpv4, numericIpv4, refusedRange, resolveChecked, type LookupFn } from '../../src/hosts/resolve.js';
import { silentLogger } from '../helpers/fakes.js';

const FP = `SHA256:${'Q'.repeat(43)}`;

function lookupOf(table: Record<string, string[]>): LookupFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (host: string) => {
    calls.push(host);
    const found = table[host];
    if (found === undefined) throw new Error('ENOTFOUND');
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(fn, { calls });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolve, then check', () => {
  it('reads short numeric IPv4 forms the way inet_aton does', () => {
    expect(numericIpv4('2852039166')).toBe('169.254.169.254');
    expect(numericIpv4('0xa9fea9fe')).toBe('169.254.169.254');
    expect(numericIpv4('169.254.43518')).toBe('169.254.169.254');
    expect(numericIpv4('0251.0376.0251.0376')).toBe('169.254.169.254');
    expect(numericIpv4('192.0.2.10')).toBe('192.0.2.10');
    expect(numericIpv4('mars.example.com')).toBeNull();
    expect(numericIpv4('4294967296')).toBeNull();
    expect(numericIpv4('192.0.2.1.5')).toBeNull();
  });

  it('refuses link-local, unspecified, multicast and broadcast addresses, v4 and v6, mapped forms included', () => {
    for (const address of ['169.254.0.1', '169.254.169.254', '0.0.0.0', [0, 1, 2, 3].join('.'), '224.0.0.251', '239.1.1.1', '255.255.255.255',
      '::', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '::ffff:169.254.0.1']) {
      expect(refusedRange(address), address).not.toBeNull();
    }
    // A private range is named on purpose: a server on the owner's own network must stay reachable.
    for (const address of ['192.0.2.10', '198.51.100.7', '203.0.113.9', '127.0.0.1', '10.1.2.3', '::1', '2001:db8::5']) {
      expect(refusedRange(address), address).toBeNull();
    }
  });

  it('un-maps NAT64, 6to4, mapped and IPv4-compatible IPv6 forms before the check', () => {
    expect(embeddedIpv4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('64:ff9b::169.254.169.254')).toBe('169.254.169.254');
    expect(embeddedIpv4('2002:a9fe:a9fe::1')).toBe('169.254.169.254');
    expect(embeddedIpv4('::169.254.169.254')).toBe('169.254.169.254');
    expect(embeddedIpv4('::a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedIpv4('::1')).toBeNull();
    expect(embeddedIpv4('2001:db8::5')).toBeNull();
    for (const address of ['64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::169.254.169.254', '::a9fe:a9fe', '64:ff9b::6464:64c8', '2002:e000:00fb::']) {
      expect(refusedRange(address), address).not.toBeNull();
    }
    // The same forms around an ordinary address stay allowed.
    for (const address of ['64:ff9b::c000:20a', '2002:c000:020a::1', '::ffff:198.51.100.7']) {
      expect(refusedRange(address), address).toBeNull();
    }
  });

  it('refuses the cloud metadata addresses and the reserved ranges', () => {
    for (const address of ['100.100.100.200', '100.100.100.100', 'fd00:ec2::254', [192, 0, 0, 192].join('.'), '::ffff:c000:c0', '240.0.0.1', '255.255.255.255']) {
      expect(refusedRange(address), address).not.toBeNull();
    }
    // The rest of the carrier-grade NAT range is where mesh VPNs number the owner's own machines: it stays reachable.
    for (const address of ['100.64.0.1', '100.101.102.103', 'fd7a:115c:a1e0::1']) {
      expect(refusedRange(address), address).toBeNull();
    }
  });

  it('a name that resolves to 169.254.0.1 is refused; one bad address among good ones is enough', async () => {
    const lookup = lookupOf({ 'mars.example.com': ['169.254.0.1'], 'ash.example.com': ['192.0.2.10', 'fe80::1'] });
    await expect(resolveChecked('mars.example.com', lookup)).rejects.toMatchObject({ code: 'address_refused' });
    await expect(resolveChecked('ash.example.com', lookup)).rejects.toMatchObject({ code: 'address_refused' });
  });

  it('the numeric form 2852039166 is refused without asking the resolver', async () => {
    const lookup = lookupOf({});
    await expect(resolveChecked('2852039166', lookup)).rejects.toMatchObject({ code: 'address_refused' });
    expect(lookup.calls).toEqual([]);
  });

  it('returns the first checked address; an unknown name is unreachable', async () => {
    const lookup = lookupOf({ 'birch.example.com': ['198.51.100.7', '2001:db8::5'] });
    await expect(resolveChecked('birch.example.com', lookup)).resolves.toBe('198.51.100.7');
    await expect(resolveChecked('192.0.2.44', lookup)).resolves.toBe('192.0.2.44');
    await expect(resolveChecked('cedar.example.com', lookup)).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('the SSH executor checks at connect time: no socket is opened for a refused address, the link reports network', async () => {
    const connect = vi.spyOn(Socket.prototype, 'connect');
    for (const host of ['mars.example.com', '2852039166']) {
      const executor = createSshExecutor({
        name: 'mars', host, port: 22, username: 'dev', hostKeyFp: FP, privateKeyPath: '/nonexistent/key', ctlPath: '~/.luady/bin/luady-ctl',
        log: silentLogger(), policy: { initialMs: 60_000, maxMs: 60_000, offlineAfter: 1 },
        lookup: lookupOf({ 'mars.example.com': ['169.254.0.1'] }),
      });
      executor.start();
      await vi.waitFor(() => expect(executor.lastError?.()).toBe('network'));
      await executor.close();
    }
    expect(connect).not.toHaveBeenCalled();
  });
});
