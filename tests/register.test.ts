import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/register.js';
import { prisma } from '../src/lib/prisma.js';
import { verifyDeviceToken } from '../src/lib/deviceToken.js';
import { requireQuotaDeviceId } from '../src/contracts/http.js';
import { tokenFor } from './helpers/deviceToken.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      upsert: vi.fn(),
    },
    callCount: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };
  return res as unknown as VercelResponse;
}

function mockReq(method: string, headers: Record<string, string>) {
  return {
    method,
    headers,
  } as unknown as VercelRequest;
}

type MockResShape = { statusCode: number; body: unknown; headers: Record<string, string> };

const validHex = 'a'.repeat(64);

function mockDevice(deviceId = validHex) {
  vi.mocked(prisma.device.upsert).mockResolvedValue({
    deviceId,
    registeredAt: new Date(),
    dailyRecordLimit: null,
  });
}

describe('POST /api/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROXY_SECRET = 'test-secret';
    process.env.DEVICE_TOKEN_SECRET ??= 'test-device-token-secret';
    delete process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY;
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 1 }] as never);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0 as never);
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue(null);
  });

  it('rejects non-POST requests with 405', async () => {
    const req = mockReq('GET', {});
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(405);
    expect(r.body).toEqual({ error: 'Method not allowed' });
  });

  it('rejects invalid proxy secret with 401', async () => {
    const req = mockReq('POST', {
      'x-proxy-secret': 'wrong-secret',
    });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: 'Unauthorized' });
  });

  it('still enforces the proxy secret when a valid token is presented', async () => {
    const req = mockReq('POST', {
      'x-proxy-secret': 'wrong-secret',
      'x-device-token': tokenFor(validHex),
    });
    const res = mockRes();

    await handler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(401);
    expect(prisma.device.upsert).not.toHaveBeenCalled();
  });

  it('rejects missing or invalid device ID with 400 in Mode A', async () => {
    const req1 = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
    });
    const res1 = mockRes();
    await handler(req1, res1);
    expect((res1 as unknown as MockResShape).statusCode).toBe(400);

    const req2 = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': 'invalid-hex-here',
    });
    const res2 = mockRes();
    await handler(req2, res2);
    expect((res2 as unknown as MockResShape).statusCode).toBe(400);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('issues a token the quota-endpoint guard accepts (cross-endpoint)', async () => {
    mockDevice();
    const req = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': validHex,
    });
    const res = mockRes();
    await handler(req, res);

    const body = (res as unknown as MockResShape).body as { token?: string };
    expect(typeof body.token).toBe('string');

    // The same token must be accepted by the shared guard transcribe/cleanup/tag use.
    const guard = requireQuotaDeviceId(
      mockReq('POST', { 'x-device-token': body.token as string }),
    );
    expect(guard).toEqual({ deviceId: validHex });
  });

  describe('Mode A (no valid token)', () => {
    it('issues a verifiable token bound to the device id, returns quota, and increments the counter', async () => {
      mockDevice();
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-id': validHex,
        'x-real-ip': '9.9.9.9',
      });
      const res = mockRes();

      await handler(req, res);

      expect(prisma.device.upsert).toHaveBeenCalledWith({
        where: { deviceId: validHex },
        update: {},
        create: { deviceId: validHex },
        select: { deviceId: true, dailyRecordLimit: true },
      });
      expect(prisma.$queryRaw).toHaveBeenCalledOnce();
      const call = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as unknown[];
      expect(call[1]).toBe('9.9.9.9');

      const r = res as unknown as MockResShape;
      expect(r.statusCode).toBe(201);
      expect(r.body).toEqual({
        ok: true,
        token: expect.any(String),
        quota: { limit: 3, count: 0, remaining: 3, resetAt: expect.any(String) },
      });
      expect(verifyDeviceToken((r.body as { token: string }).token)).toEqual({
        deviceId: validHex,
      });
    });

    it('returns 429 once the per-IP cap is exceeded and creates no device', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 11 }] as never);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-id': validHex,
        'x-forwarded-for': '9.9.9.9, 10.0.0.1',
      });
      const res = mockRes();

      await handler(req, res);

      const r = res as unknown as MockResShape;
      expect(r.statusCode).toBe(429);
      expect(r.body).toEqual({ error: expect.any(String) });
      expect(prisma.device.upsert).not.toHaveBeenCalled();
    });

    it('allows the 10th registration and honors MAX_REGISTRATIONS_PER_IP_PER_DAY', async () => {
      mockDevice();
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 10 }] as never);
      const headers = { 'x-proxy-secret': 'test-secret', 'x-device-id': validHex };

      const res1 = mockRes();
      await handler(mockReq('POST', headers), res1);
      expect((res1 as unknown as MockResShape).statusCode).toBe(201);

      process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY = '5';
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res2 = mockRes();
      await handler(mockReq('POST', headers), res2);
      expect((res2 as unknown as MockResShape).statusCode).toBe(429);
    });

    it('treats an invalid token as Mode A (no 403) and issues a fresh token', async () => {
      mockDevice();
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-id': validHex,
        'x-device-token': 'garbage.token',
      });
      const res = mockRes();

      await handler(req, res);

      const r = res as unknown as MockResShape;
      expect(r.statusCode).toBe(201);
      expect(prisma.$queryRaw).toHaveBeenCalledOnce();
      expect(verifyDeviceToken((r.body as { token: string }).token)).toEqual({
        deviceId: validHex,
      });
    });

    it('returns 400 when the token is invalid and no valid device id accompanies it', async () => {
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-token': 'garbage.token',
      });
      const res = mockRes();

      await handler(req, res);

      expect((res as unknown as MockResShape).statusCode).toBe(400);
    });

    it('migration: preserves an existing device CallCount quota', async () => {
      mockDevice();
      vi.mocked(prisma.callCount.findUnique).mockResolvedValue({ count: 2 } as never);
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-id': validHex,
      });
      const res = mockRes();

      await handler(req, res);

      const r = res as unknown as MockResShape;
      expect(r.statusCode).toBe(201);
      expect(r.body).toMatchObject({
        ok: true,
        token: expect.any(String),
        quota: { limit: 3, count: 2, remaining: 1 },
      });
      expect(prisma.callCount.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId_date_type: expect.objectContaining({ deviceId: validHex }) },
        }),
      );
    });

    it('handles database errors internally with 500', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(prisma.device.upsert).mockRejectedValue(new Error('DB Error'));
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-id': validHex,
      });
      const res = mockRes();

      await handler(req, res);

      const r = res as unknown as MockResShape;
      expect(r.statusCode).toBe(500);
      expect(r.body).toEqual({ error: 'Internal server error' });
    });
  });

  describe('Mode B (valid token)', () => {
    it('returns quota for the token id, issues no new token, and is not rate-limited', async () => {
      const otherId = 'b'.repeat(64);
      mockDevice(otherId);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ count: 9999 }] as never);
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-token': tokenFor(otherId),
      });
      const res = mockRes();

      await handler(req, res);

      const r = res as unknown as MockResShape;
      expect(r.statusCode).toBe(201);
      expect(r.body).toEqual({
        ok: true,
        quota: { limit: 3, count: 0, remaining: 3, resetAt: expect.any(String) },
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.device.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deviceId: otherId } }),
      );
    });

    it('keys on the token id, ignoring a different X-Device-Id', async () => {
      mockDevice();
      const req = mockReq('POST', {
        'x-proxy-secret': 'test-secret',
        'x-device-token': tokenFor(validHex),
        'x-device-id': 'c'.repeat(64),
      });
      const res = mockRes();

      await handler(req, res);

      expect(prisma.device.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deviceId: validHex } }),
      );
    });
  });
});
