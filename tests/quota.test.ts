import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { CallCountType } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import {
  buildDailyRecordLimitExceededResponse,
  buildRecordQuota,
  DEFAULT_DAILY_RECORD_LIMIT,
  getEffectiveQuotaLimit,
  getNextUTCDayReset,
  resolveDailyRecordLimit,
  verifyDailyRecordQuota,
} from '../src/lib/quota.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    callCount: {
      findUnique: vi.fn(),
    },
  },
}));

describe('quota helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the hardcoded default when the device override is null', () => {
    expect(resolveDailyRecordLimit(null)).toBe(DEFAULT_DAILY_RECORD_LIMIT);
  });

  it('uses zero as an explicit block value', () => {
    expect(resolveDailyRecordLimit(0)).toBe(0);
  });

  it('clamps negative explicit limits to zero', () => {
    expect(resolveDailyRecordLimit(-1)).toBe(0);
  });

  it('doubles the transcription quota from the base device limit', () => {
    expect(getEffectiveQuotaLimit(3, CallCountType.TRANSCRIPTION)).toBe(6);
  });

  it('keeps the cleanup quota equal to the base device limit', () => {
    expect(getEffectiveQuotaLimit(3, CallCountType.CLEANUP)).toBe(3);
  });

  it('returns the next UTC midnight for resetAt', () => {
    const dayBucket = new Date('2026-05-21T00:00:00.000Z');
    expect(getNextUTCDayReset(dayBucket).toISOString()).toBe('2026-05-22T00:00:00.000Z');
  });

  it('builds a non-negative remaining quota value', () => {
    const quota = buildRecordQuota(3, 5, new Date('2026-05-21T00:00:00.000Z'));
    expect(quota).toEqual({
      limit: 3,
      count: 5,
      remaining: 0,
      resetAt: '2026-05-22T00:00:00.000Z',
    });
  });

  it('builds the quota-exceeded payload shape', () => {
    const body = buildDailyRecordLimitExceededResponse({
      limit: 3,
      count: 3,
      remaining: 0,
      resetAt: '2026-05-22T00:00:00.000Z',
    });

    expect(body).toEqual({
      error: 'Daily record limit exceeded',
      quota: {
        limit: 3,
        count: 3,
        remaining: 0,
        resetAt: '2026-05-22T00:00:00.000Z',
      },
    });
  });

  it('allows requests below the limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:00:00.000Z'));
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue({ count: 2 } as never);

    const result = await verifyDailyRecordQuota('a'.repeat(64), 5, CallCountType.CLEANUP, 'test');

    expect(result).toEqual({
      allowed: true,
      quota: {
        limit: 5,
        count: 2,
        remaining: 3,
        resetAt: '2026-05-22T00:00:00.000Z',
      },
    });
  });

  it('blocks requests at the limit with a 429 payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:00:00.000Z'));
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue({ count: 3 } as never);

    const result = await verifyDailyRecordQuota('a'.repeat(64), null, CallCountType.CLEANUP, 'test');

    expect(result).toEqual({
      allowed: false,
      status: 429,
      body: {
        error: 'Daily record limit exceeded',
        quota: {
          limit: 3,
          count: 3,
          remaining: 0,
          resetAt: '2026-05-22T00:00:00.000Z',
        },
      },
    });
  });

  it('uses the doubled transcription limit for quota checks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:00:00.000Z'));
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue({ count: 6 } as never);

    const result = await verifyDailyRecordQuota('a'.repeat(64), null, CallCountType.TRANSCRIPTION, 'test');

    expect(result).toEqual({
      allowed: false,
      status: 429,
      body: {
        error: 'Daily record limit exceeded',
        quota: {
          limit: 6,
          count: 6,
          remaining: 0,
          resetAt: '2026-05-22T00:00:00.000Z',
        },
      },
    });
  });
});
