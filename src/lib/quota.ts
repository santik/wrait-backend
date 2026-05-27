import { CallCountType } from '@prisma/client';
import { getUTCDayBucket } from './callCount.js';
import { prisma } from './prisma.js';

export const DEFAULT_DAILY_RECORD_LIMIT = 3;
export const DAILY_RECORD_LIMIT_EXCEEDED_ERROR = 'Daily record limit exceeded';
export const TRANSCRIPTION_QUOTA_MULTIPLIER = 2;

export type RecordQuota = {
  limit: number;
  count: number;
  remaining: number;
  resetAt: string;
};

export type DailyRecordLimitExceededResponse = {
  error: typeof DAILY_RECORD_LIMIT_EXCEEDED_ERROR;
  quota: RecordQuota;
};

export type VerifyDailyRecordQuotaResult =
  | { allowed: true; quota: RecordQuota }
  | { allowed: false; status: 429; body: DailyRecordLimitExceededResponse }
  | { allowed: false; status: 500; body: { error: 'Internal server error' } };

export function resolveDailyRecordLimit(dailyRecordLimit: number | null | undefined): number {
  if (dailyRecordLimit == null) {
    return DEFAULT_DAILY_RECORD_LIMIT;
  }
  return Math.max(dailyRecordLimit, 0);
}

export function getEffectiveQuotaLimit(
  dailyRecordLimit: number | null | undefined,
  type: CallCountType,
): number {
  const baseLimit = resolveDailyRecordLimit(dailyRecordLimit);
  return type === CallCountType.TRANSCRIPTION
    ? baseLimit * TRANSCRIPTION_QUOTA_MULTIPLIER
    : baseLimit;
}

export function getNextUTCDayReset(dayBucket: Date): Date {
  const nextReset = new Date(dayBucket);
  nextReset.setUTCDate(nextReset.getUTCDate() + 1);
  return nextReset;
}

export function buildRecordQuota(limit: number, count: number, dayBucket: Date): RecordQuota {
  return {
    limit,
    count,
    remaining: Math.max(limit - count, 0),
    resetAt: getNextUTCDayReset(dayBucket).toISOString(),
  };
}

export function buildDailyRecordLimitExceededResponse(
  quota: RecordQuota,
): DailyRecordLimitExceededResponse {
  return {
    error: DAILY_RECORD_LIMIT_EXCEEDED_ERROR,
    quota,
  };
}

export async function getSuccessfulCallCount(
  deviceId: string,
  dayBucket: Date,
  type: CallCountType,
): Promise<number> {
  const callCount = await prisma.callCount.findUnique({
    where: {
      deviceId_date_type: {
        deviceId,
        date: dayBucket,
        type,
      },
    },
    select: { count: true },
  });

  return callCount?.count ?? 0;
}

export async function verifyDailyRecordQuota(
  deviceId: string,
  dailyRecordLimit: number | null | undefined,
  type: CallCountType,
  label: string,
): Promise<VerifyDailyRecordQuotaResult> {
  const dayBucket = getUTCDayBucket();
  const limit = getEffectiveQuotaLimit(dailyRecordLimit, type);

  try {
    const count = await getSuccessfulCallCount(deviceId, dayBucket, type);
    const quota = buildRecordQuota(limit, count, dayBucket);

    if (count >= limit) {
      return {
        allowed: false,
        status: 429,
        body: buildDailyRecordLimitExceededResponse(quota),
      };
    }

    return { allowed: true, quota };
  } catch (error) {
    console.error(`[${label}] Failed to verify daily record quota:`, {
      error: error instanceof Error ? error.message : String(error),
      deviceId,
      quotaType: type,
      configuredDailyRecordLimit: dailyRecordLimit,
      effectiveLimit: limit,
      dayBucket: dayBucket.toISOString(),
    });
    return {
      allowed: false,
      status: 500,
      body: { error: 'Internal server error' },
    };
  }
}
