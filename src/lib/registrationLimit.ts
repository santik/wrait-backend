import type { VercelRequest } from '@vercel/node';
import { getUTCDayBucket } from './callCount.js';
import { isTransientDbError, RETRY_DELAYS_MS, sleep } from './dbRetry.js';
import { prisma } from './prisma.js';

export const DEFAULT_MAX_REGISTRATIONS_PER_IP_PER_DAY = 10;

// Per-IP registration counters older than this are pruned best-effort, bounding
// table growth and how long client IPs are retained.
export const REGISTRATION_ATTEMPT_RETENTION_DAYS = 30;

const MAX_IP_LENGTH = 45; // longest textual IPv6 form
const IP_CHARS = /^[0-9a-fA-F:.%]+$/;

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : undefined;
}

// Trims, length-caps, and charset-checks an IP string before it is stored or
// used as a counter key. Returns null for empty/implausible values.
function sanitizeIp(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const capped = trimmed.slice(0, MAX_IP_LENGTH);
  return IP_CHARS.test(capped) ? capped : null;
}

export function getClientIp(req: VercelRequest): string {
  // Trust x-real-ip first: on Vercel the edge sets it to the connecting client
  // IP and overwrites any client-supplied value, so it is the trustworthy
  // source in production. x-forwarded-for is a best-effort fallback for
  // non-Vercel/local runs only; its left-most entry can be spoofed off-platform,
  // so it is used solely when x-real-ip is absent. Header-less requests all
  // share the single 'unknown' bucket, which fails safe (they collectively hit
  // the cap) rather than granting unlimited quota.
  const realIp = sanitizeIp(firstHeaderValue(req.headers['x-real-ip']));
  if (realIp) return realIp;

  const forwardedFor = firstHeaderValue(req.headers['x-forwarded-for']);
  const forwardedFirst = sanitizeIp(forwardedFor?.split(',')[0]);
  return forwardedFirst ?? 'unknown';
}

export function getMaxRegistrationsPerIpPerDay(): number {
  const parsed = Number.parseInt(process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY ?? '', 10);
  // Require at least 1 so a misconfiguration (0, negative, non-numeric) cannot
  // silently lock out every new user; fall back to the default instead.
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_MAX_REGISTRATIONS_PER_IP_PER_DAY;
}

// Atomically increments the (ip, UTC day) counter and returns the new count.
// Retries transient DB errors with short backoff, mirroring incrementCallCount.
export async function recordRegistrationAttempt(
  ip: string,
  dayBucket = getUTCDayBucket(),
): Promise<number> {
  let lastError: unknown;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await sleep(RETRY_DELAYS_MS[attempt]);
    }

    try {
      const rows = await prisma.$queryRaw<{ count: number }[]>`
        INSERT INTO "registration_attempts" ("ip", "date", "count")
        VALUES (${ip}, ${dayBucket}, 1)
        ON CONFLICT ("ip", "date")
        DO UPDATE SET "count" = "registration_attempts"."count" + 1
        RETURNING "count"
      `;
      return Number(rows[0].count);
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || attempt === RETRY_DELAYS_MS.length - 1) {
        throw error;
      }
    }
  }

  throw lastError;
}

export function isOverRegistrationLimit(count: number): boolean {
  return count > getMaxRegistrationsPerIpPerDay();
}

// Best-effort removal of counters older than the retention window. Callers must
// not fail the request if this throws; it is not on the correctness path.
export async function pruneOldRegistrationAttempts(dayBucket = getUTCDayBucket()): Promise<void> {
  const cutoff = new Date(dayBucket);
  cutoff.setUTCDate(cutoff.getUTCDate() - REGISTRATION_ATTEMPT_RETENTION_DAYS);
  await prisma.$executeRaw`DELETE FROM "registration_attempts" WHERE "date" < ${cutoff}`;
}
