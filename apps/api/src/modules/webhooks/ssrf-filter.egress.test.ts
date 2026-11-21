import { describe, it, expect } from 'vitest';
import { isBlockedIpAddress, SsrfFilter } from './ssrf-filter';

describe('isBlockedIpAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
  ])('blocks %s', (ip) => {
    expect(isBlockedIpAddress(ip).blocked).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '::ffff:5db8:d822'])('allows %s', (ip) => {
    expect(isBlockedIpAddress(ip).blocked).toBe(false);
  });
});

describe('SsrfFilter.validateAndResolve', () => {
  const make = (addrs: string[]) =>
    new SsrfFilter({
      dnsResolver: async () =>
        addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    });

  it('rejects mapped-IPv6 literal for loopback', async () => {
    await expect(make([]).validateAndResolve('https://[::ffff:7f00:1]/hook')).rejects.toThrow();
  });

  it('rejects host that resolves to cloud metadata IP', async () => {
    await expect(
      make(['169.254.169.254']).validateAndResolve('https://evil.example.com/hook')
    ).rejects.toThrow();
  });

  it('rejects when any resolved IP is private (rebinding mix)', async () => {
    await expect(
      make(['93.184.216.34', '10.0.0.5']).validateAndResolve('https://evil.example.com/hook')
    ).rejects.toThrow();
  });

  it('accepts public host and pins its IP', async () => {
    const t = await make(['93.184.216.34']).validateAndResolve('https://hooks.example.com/x');
    expect(t.pinnedIp).toBe('93.184.216.34');
  });
});
