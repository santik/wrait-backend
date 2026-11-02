import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import { prisma } from '../src/lib/prisma.js';
import {
  getClientIp,
  isOverRegistrationLimit,
  pruneOldRegistrationAttempts,
  recordRegistrationAttempt,
} from '../src/lib/registrationLimit.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

function req(headers: Record<string, string>) {
  return { headers } as unknown as VercelRequest;
}

describe('getClientIp', () => {
  it('prefers x-real-ip over x-forwarded-for', () => {
    expect(getClientIp(req({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe(
      '1.1.1.1',
    );
  });

  it('falls back to the left-most x-forwarded-for value', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }))).toBe('2.2.2.2');
  });

  it('returns "unknown" when no IP headers are present', () => {
    expect(getClientIp(req({}))).toBe('unknown');
  });

  it('trims surrounding whitespace in the forwarded value', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '  2.2.2.2 , 3.3.3.3' }))).toBe('2.2.2.2');
  });

  it('accepts IPv6 addresses', () => {
    expect(getClientIp(req({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('accepts a fully expanded IPv6 address', () => {
    const full = '2001:0db8:0000:0000:0000:0000:0000:0001';
    expect(getClientIp(req({ 'x-real-ip': full }))).toBe(full);
  });

  it('buckets a link-local zone id (not a real client IP) to "unknown"', () => {
    // Interface names (eth0) fall outside the hex/colon/dot/% charset, and a
    // link-local zone id never appears in an edge-set client-IP header anyway,
    // so falling back to the fail-safe bucket is the intended behavior.
    expect(getClientIp(req({ 'x-real-ip': 'fe80::1%eth0' }))).toBe('unknown');
  });

  it('accepts an IPv4-mapped IPv6 address', () => {
    expect(getClientIp(req({ 'x-real-ip': '::ffff:192.168.0.1' }))).toBe(
      '::ffff:192.168.0.1',
    );
  });

  it('rejects implausible values and falls back to "unknown"', () => {
    expect(getClientIp(req({ 'x-real-ip': 'not an ip!' }))).toBe('unknown');
  });

  it('truncates an over-long IP string to the max length', () => {
    const result = getClientIp(req({ 'x-real-ip': '1'.repeat(60) }));
    expect(result.length).toBe(45);
  });

  it('uses the first entry when the header is provided as an array', () => {
    const headers = { 'x-real-ip': ['9.9.9.9', '8.8.8.8'] } as unknown as Record<string, string>;
    expect(getClientIp(req(headers))).toBe('9.9.9.9');
  });
});

describe('recordRegistrationAttempt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY;
  });

  it('increments via a single atomic upsert and returns the new count', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 4 }] as never);

    const count = await recordRegistrationAttempt('1.1.1.1');

    expect(count).toBe(4);
    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    const call = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(call[0].join('?')).toContain('ON CONFLICT ("ip", "date")');
    expect(call[1]).toBe('1.1.1.1');
  });

  it('uses a new UTC-day bucket each day so the counter resets', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 1 }] as never);

    vi.setSystemTime(new Date('2026-10-21T23:59:00.000Z'));
    await recordRegistrationAttempt('1.1.1.1');
    vi.setSystemTime(new Date('2026-10-22T00:01:00.000Z'));
    await recordRegistrationAttempt('1.1.1.1');

    const dates = vi
      .mocked(prisma.$queryRaw)
      .mock.calls.map((c) => (c as unknown as unknown[])[2] as Date);
    expect(dates[0].toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(dates[1].toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('applies the default cap of 10 and an env override', () => {
    expect(isOverRegistrationLimit(10)).toBe(false);
    expect(isOverRegistrationLimit(11)).toBe(true);

    process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY = '2';
    expect(isOverRegistrationLimit(2)).toBe(false);
    expect(isOverRegistrationLimit(3)).toBe(true);
  });

  it('clamps a zero/negative/invalid cap to the default instead of locking out', () => {
    process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY = '0';
    expect(isOverRegistrationLimit(10)).toBe(false);
    expect(isOverRegistrationLimit(11)).toBe(true);

    process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY = '-5';
    expect(isOverRegistrationLimit(10)).toBe(false);

    process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY = 'nope';
    expect(isOverRegistrationLimit(10)).toBe(false);
  });
});

describe('pruneOldRegistrationAttempts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes counters older than the retention window', async () => {
    vi.setSystemTime(new Date('2026-10-21T10:00:00.000Z'));
    vi.mocked(prisma.$executeRaw).mockResolvedValue(3 as never);

    await pruneOldRegistrationAttempts();

    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    const call = vi.mocked(prisma.$executeRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(call[0].join('?')).toContain('DELETE FROM "registration_attempts"');
    const cutoff = call[1] as Date;
    // 30 days before the 2026-10-21 UTC day bucket.
    expect(cutoff.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
});
