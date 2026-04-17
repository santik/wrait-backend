import { CallCountType } from '@prisma/client';
import { prisma } from './prisma.js';

const TRANSIENT_DB_ERROR_PATTERNS = ['timeout', 'timed out', 'connection', 'econn', 'too many clients'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getUTCDayBucket(): Date {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return today;
}

// Raw SQL cast ${type}::"CallCountType" relies on Prisma's enum string matching the PG enum value.
// If the enum is renamed in schema.prisma, this cast must be updated to match.
export async function incrementCallCount(
  deviceId: string,
  date: Date,
  type: CallCountType,
  label: string,
): Promise<void> {
  const retryDelaysMs = [0, 25, 75];

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }

    try {
      await prisma.$executeRaw`
        INSERT INTO "call_counts" ("device_id", "date", "type", "count")
        VALUES (${deviceId}, ${date}, ${type}::"CallCountType", 1)
        ON CONFLICT ("device_id", "date", "type")
        DO UPDATE SET "count" = "call_counts"."count" + 1
      `;
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const normalizedMessage = errorMessage.toLowerCase();
      const isTransient = TRANSIENT_DB_ERROR_PATTERNS.some((p) => normalizedMessage.includes(p));
      const isLastAttempt = attempt === retryDelaysMs.length - 1;

      if (!isTransient || isLastAttempt) {
        console.error(`[${label}] Failed to store call count:`, {
          error: errorMessage,
          deviceId,
          date: date.toISOString(),
          type,
          attempt: attempt + 1,
          transient: isTransient,
        });
        return;
      }
    }
  }
}
