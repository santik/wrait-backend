import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { getUTCDayBucket } from '../lib/callCount.js';
import { ensureDevice } from '../lib/device.js';
import {
  buildRecordQuota,
  getEffectiveQuotaLimit,
  getSuccessfulCallCount,
} from '../lib/quota.js';
import { signDeviceToken } from '../lib/deviceToken.js';
import {
  getClientIp,
  isOverRegistrationLimit,
  pruneOldRegistrationAttempts,
  recordRegistrationAttempt,
} from '../lib/registrationLimit.js';
import {
  errorResponse,
  readDeviceToken,
  requireDeviceId,
  requirePostMethod,
  requireProxySecret,
} from './http.js';
import type { OperationResult } from './http.js';
import type { RegisterResponseBody } from './openapi.js';

// Records the attempt and enforces the per-IP cap for a Mode A (tokenless)
// registration. Returns a 429/500 result to send, or null when the request may
// proceed. Retention pruning runs here, off the common path — only on the first
// attempt for the IP that day — so it is not a per-request DB round trip.
async function enforceRegistrationLimit(
  req: VercelRequest,
): Promise<OperationResult<never> | null> {
  const ip = getClientIp(req);

  let attempts: number;
  try {
    attempts = await recordRegistrationAttempt(ip);
  } catch (error) {
    console.error('Failed to record registration attempt:', error);
    return { status: 500, body: errorResponse('Internal server error') };
  }

  if (isOverRegistrationLimit(attempts)) {
    console.warn('[register] Registration rate limit exceeded', { ip, attempts });
    return { status: 429, body: errorResponse('Too many registrations, try again later') };
  }

  if (attempts === 1) {
    try {
      await pruneOldRegistrationAttempts();
    } catch (pruneError) {
      console.warn('[register] Failed to prune old registration attempts', {
        error: pruneError instanceof Error ? pruneError.message : String(pruneError),
      });
    }
  }

  return null;
}

export async function handleRegister(
  req: VercelRequest,
): Promise<OperationResult<RegisterResponseBody>> {
  const methodError = requirePostMethod(req);
  if (methodError) return methodError;

  const authError = requireProxySecret(req);
  if (authError) return authError;

  // Mode B: a valid token identifies a returning device — no rate limit, no new
  // token. Mode A: no (or invalid) token — require X-Device-Id, rate-limit per
  // IP, and issue a token.
  const tokenDevice = readDeviceToken(req);
  let deviceId: string;
  if (tokenDevice) {
    deviceId = tokenDevice.deviceId;
  } else {
    const device = requireDeviceId(req);
    if ('status' in device) return device;
    const limitError = await enforceRegistrationLimit(req);
    if (limitError) return limitError;
    deviceId = device.deviceId;
  }

  try {
    const ensuredDevice = await ensureDevice(deviceId);
    const token = tokenDevice ? undefined : signDeviceToken(ensuredDevice.deviceId);
    console.log('Device registered successfully with ID', ensuredDevice.deviceId);

    const body: RegisterResponseBody = { ok: true, ...(token ? { token } : {}) };

    try {
      const dayBucket = getUTCDayBucket();
      const cleanupCount = await getSuccessfulCallCount(
        ensuredDevice.deviceId,
        dayBucket,
        CallCountType.CLEANUP,
      );
      const cleanupLimit = getEffectiveQuotaLimit(
        ensuredDevice.dailyRecordLimit,
        CallCountType.CLEANUP,
      );

      return {
        status: 201,
        body: { ...body, quota: buildRecordQuota(cleanupLimit, cleanupCount, dayBucket) },
      };
    } catch (error) {
      console.error('[register] Failed to load cleanup quota after successful registration:', {
        error: error instanceof Error ? error.message : String(error),
        deviceId: ensuredDevice.deviceId,
      });

      return { status: 201, body };
    }
  } catch (error) {
    console.error('Failed to register device:', error);
    return { status: 500, body: errorResponse('Internal server error') };
  }
}
