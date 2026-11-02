// Shared transient-DB-error detection and backoff schedule for best-effort DB
// writes. The retry *loops* live at each call site because their failure
// contracts differ (incrementCallCount swallows and returns false with rich
// per-attempt logging; recordRegistrationAttempt rethrows) — only these
// contract-free primitives are shared.

export const RETRY_DELAYS_MS = [0, 25, 75];

const TRANSIENT_DB_ERROR_PATTERNS = [
  'timeout',
  'timed out',
  'connection',
  'econn',
  'too many clients',
];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientDbError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return TRANSIENT_DB_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}
