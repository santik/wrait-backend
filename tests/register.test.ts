import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/register.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      upsert: vi.fn(),
    },
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

describe('POST /api/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROXY_SECRET = 'test-secret';
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

  it('rejects missing or invalid device ID with 400', async () => {
    // Missing device ID
    const req1 = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
    });
    const res1 = mockRes();
    await handler(req1, res1);
    expect((res1 as unknown as MockResShape).statusCode).toBe(400);

    // Invalid length / format
    const req2 = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': 'invalid-hex-here',
    });
    const res2 = mockRes();
    await handler(req2, res2);
    expect((res2 as unknown as MockResShape).statusCode).toBe(400);
  });

  it('upserts device and returns 201 on success', async () => {
    const validHex = 'a'.repeat(64);
    const req = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': validHex,
    });
    const res = mockRes();

    vi.mocked(prisma.device.upsert).mockResolvedValue({
      deviceId: validHex,
      registeredAt: new Date(),
    });

    await handler(req, res);

    expect(prisma.device.upsert).toHaveBeenCalledWith({
      where: { deviceId: validHex },
      update: {},
      create: { deviceId: validHex },
    });

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(201);
    expect(r.body).toEqual({ ok: true });
  });

  it('handles database errors internally with 500', async () => {
    const validHex = 'a'.repeat(64);
    const req = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': validHex,
    });
    const res = mockRes();

    // Prevent console.error from cluttering strictly testing output
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.device.upsert).mockRejectedValue(new Error('DB Error'));

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Internal server error' });
  });
});
