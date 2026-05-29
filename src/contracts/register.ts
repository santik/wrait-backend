import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { getUTCDayBucket } from '../lib/callCount.js';
import { ensureDevice } from '../lib/device.js';
import {
  buildRecordQuota,
  getEffectiveQuotaLimit,
  getSuccessfulCallCount,
} from '../lib/quota.js';
import { errorResponse, requireDeviceId, requirePostMethod, requireProxySecret } from './http.js';
import type { OperationResult } from './http.js';
import type { RegisterResponseBody } from './openapi.js';

export async function handleRegister(
  req: VercelRequest,
): Promise<OperationResult<RegisterResponseBody>> {
  const methodError = requirePostMethod(req);
  if (methodError) return methodError;

  const authError = requireProxySecret(req);
  if (authError) return authError;

  const device = requireDeviceId(req);
  if ('status' in device) return device;

  try {
    const ensuredDevice = await ensureDevice(device.deviceId);
    console.log('Device registered successfully with ID', device.deviceId);

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
        body: {
          ok: true,
          quota: buildRecordQuota(cleanupLimit, cleanupCount, dayBucket),
        },
      };
    } catch (error) {
      console.error('[register] Failed to load cleanup quota after successful registration:', {
        error: error instanceof Error ? error.message : String(error),
        deviceId: ensuredDevice.deviceId,
      });

      return { status: 201, body: { ok: true } };
    }
  } catch (error) {
    console.error('Failed to register device:', error);
    return { status: 500, body: errorResponse('Internal server error') };
  }
}
