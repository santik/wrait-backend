import type { VercelRequest } from '@vercel/node';
import { prisma } from '../lib/prisma.js';
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
    await prisma.device.upsert({
      where: { deviceId: device.deviceId },
      update: {},
      create: { deviceId: device.deviceId },
    });
    console.log('Device registered successfully with ID', device.deviceId);
    return { status: 201, body: { ok: true } };
  } catch (error) {
    console.error('Failed to register device:', error);
    return { status: 500, body: errorResponse('Internal server error') };
  }
}
