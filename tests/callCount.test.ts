import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallCountType } from '@prisma/client';
import { getUTCDayBucket, incrementCallCount } from '../src/lib/callCount.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $executeRaw: vi.fn(),
  },
}));

const DEVICE_ID = 'a'.repeat(64);
const DATE = new Date('2026-04-17T00:00:00.000Z');

// ─── getUTCDayBucket ──────────────────────────────────────────────────────────

describe('getUTCDayBucket', () => {
  afterEach(() => vi.useRealTimers());

  it('truncates current time to UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T15:30:45.123Z'));
    expect(getUTCDayBucket().toISOString()).toBe('2026-04-17T00:00:00.000Z');
  });

  it('handles end-of-day times correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T23:59:59.999Z'));
    expect(getUTCDayBucket().toISOString()).toBe('2026-04-17T00:00:00.000Z');
  });

  it('returns a different bucket on the next day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T00:00:00.001Z'));
    expect(getUTCDayBucket().toISOString()).toBe('2026-04-18T00:00:00.000Z');
  });
});

// ─── incrementCallCount ───────────────────────────────────────────────────────

describe('incrementCallCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
  });

  afterEach(() => vi.useRealTimers());

  it('calls $executeRaw with deviceId, date, and type as positional args', async () => {
    await incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    const args = vi.mocked(prisma.$executeRaw).mock.calls[0];
    // Tagged template: args[0] = TemplateStringsArray, args[1..n] = interpolated values
    expect(args[1]).toBe(DEVICE_ID);
    expect(args[2]).toBe(DATE);
    expect(args[3]).toBe(CallCountType.TRANSCRIPTION);
  });

  it('works for CLEANUP type', async () => {
    await incrementCallCount(DEVICE_ID, DATE, CallCountType.CLEANUP, 'test');

    const args = vi.mocked(prisma.$executeRaw).mock.calls[0];
    expect(args[3]).toBe(CallCountType.CLEANUP);
  });

  it('succeeds on the first attempt without retrying', async () => {
    await incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('resolves to undefined (best-effort — never throws)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('DB down'));

    await expect(
      incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test'),
    ).resolves.toBeUndefined();
  });

  it('does not retry on a non-transient error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('syntax error in query'));

    await incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('retries on a transient error and succeeds', async () => {
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    await incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts on a persistent transient error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('connection timeout'));

    await incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('logs error with the caller label on failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('syntax error'));

    await incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'my-label');

    expect(errorSpy).toHaveBeenCalledWith(
      '[my-label] Failed to store call count:',
      expect.objectContaining({
        error: 'syntax error',
        deviceId: DEVICE_ID,
        type: CallCountType.TRANSCRIPTION,
        attempt: 1,
        transient: false,
      }),
    );
  });

  // ─── retry delay timing ───────────────────────────────────────────────────

  it('waits 25ms before the second attempt', async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    const promise = incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    // Attempt 1 runs immediately (0ms delay) and fails — $executeRaw called once
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    // Advance past the 25ms sleep before attempt 2
    await vi.advanceTimersByTimeAsync(25);
    await promise;

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('waits 75ms before the third attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    const promise = incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    // Attempt 1 (0ms): immediate, fails
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    // Advance 25ms → attempt 2 runs, fails; now sleeping 75ms before attempt 3
    await vi.advanceTimersByTimeAsync(25);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);

    // Advance 75ms → attempt 3 runs, succeeds
    await vi.advanceTimersByTimeAsync(75);
    await promise;
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('does not fire attempt 2 before the 25ms delay elapses', async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    const promise = incrementCallCount(DEVICE_ID, DATE, CallCountType.TRANSCRIPTION, 'test');

    // Only 10ms elapsed — attempt 2 must not have started yet
    await vi.advanceTimersByTimeAsync(10);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    // Now advance to full 25ms
    await vi.advanceTimersByTimeAsync(15);
    await promise;
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });
});
