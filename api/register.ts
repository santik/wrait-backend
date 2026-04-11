import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from '../src/lib/response.js';
import { prisma } from '../src/lib/prisma.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return json(res, { error: 'Method not allowed' }, 405);
  }

  const proxySecret = req.headers['x-proxy-secret'];
  const deviceId = req.headers['x-device-id'];

  if (proxySecret !== process.env.PROXY_SECRET) {
    return json(res, { error: 'Unauthorized' }, 401);
  }

  if (!deviceId || typeof deviceId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(deviceId)) {
    return json(res, { error: 'Invalid device ID' }, 400);
  }

  try {
    await prisma.device.upsert({
      where: { deviceId },
      update: {},
      create: { deviceId },
    });

    return json(res, { ok: true }, 200);
  } catch (error) {
    console.error('Failed to register device:', error);
    return json(res, { error: 'Internal server error' }, 500);
  }
}
