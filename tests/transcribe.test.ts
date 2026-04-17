import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/transcribe.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

const mockFetch = vi.fn();

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

type MockResShape = { statusCode: number; body: unknown; headers: Record<string, string> };

function mockReq(
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
  url = '/api/transcribe?model=nova-3&punctuate=true&smart_format=true&language=en&detect_language=true',
) {
  const chunks = body ? [body] : [];
  let idx = 0;
  return {
    method,
    headers,
    url,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (idx < chunks.length) {
            return { value: chunks[idx++], done: false as const };
          }
          return { value: undefined, done: true as const };
        },
      };
    },
  } as unknown as VercelRequest;
}

const deepgramSuccess = {
  results: {
    channels: [
      {
        alternatives: [{ transcript: 'hello world' }],
        detected_language: 'en',
      },
    ],
  },
};

describe('POST /api/transcribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    process.env.PROXY_SECRET = 'test-secret';
    process.env.DEEPGRAM_API_KEY = 'dg-test-key';
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ deviceId: 'a'.repeat(64) } as never);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects non-POST requests with 405', async () => {
    const req = mockReq('GET', {});
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(405);
    expect(r.body).toEqual({ error: 'Method not allowed' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing proxy secret with 401', async () => {
    const req = mockReq('POST', {});
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects wrong proxy secret with 401', async () => {
    const req = mockReq('POST', { 'x-proxy-secret': 'wrong' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing device ID with 400', async () => {
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid device ID' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.device.findUnique).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects invalid device ID format with 400', async () => {
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'abc123' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid device ID' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.device.findUnique).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects unregistered device with 404', async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: 'Device not registered' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 500 when device lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.device.findUnique).mockRejectedValue(new Error('DB down'));
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Internal server error' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('proxies audio to Deepgram and returns full response on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });

    const audio = Buffer.from('fake-audio-bytes');
    const deviceId = 'a'.repeat(64);
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': deviceId, 'content-type': 'audio/mp4' },
      audio,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(deepgramSuccess);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain('https://api.deepgram.com/v1/listen');
    expect(url).toContain('model=nova-3');
    expect(init.headers['Authorization']).toBe('Token dg-test-key');
    expect(init.headers['Content-Type']).toBe('audio/mp4');
    expect(prisma.device.findUnique).toHaveBeenCalledWith({
      where: { deviceId },
      select: { deviceId: true },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('returns 502 with Deepgram error body when Deepgram fails', async () => {
    const dgError = { error: 'Bad Request', reason: 'invalid audio' };
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => dgError,
    });

    const audio = Buffer.from('bad-audio');
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) }, audio);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual(dgError);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('forwards query parameters verbatim to Deepgram', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => deepgramSuccess });

    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      Buffer.from('audio'),
      '/api/transcribe?model=nova-3&language=nl&detect_language=true',
    );
    const res = mockRes();

    await handler(req, res);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3&language=nl&detect_language=true',
    );
  });

  it('rejects requests exceeding size limit with 413', async () => {
    const largeAudio = Buffer.alloc(26 * 1024 * 1024); // 26MB
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) }, largeAudio);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(413);
    expect(r.body).toEqual({ error: 'Request too large' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 502 when Deepgram returns invalid JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    });

    const audio = Buffer.from('audio');
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) }, audio);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'Invalid response from upstream' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when fetch throws network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const audio = Buffer.from('audio');
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) }, audio);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'Failed to reach Deepgram' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('still returns Deepgram success when call count update fails', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('DB error'));
    vi.spyOn(console, 'error').mockImplementation(() => { });

    const audio = Buffer.from('fake-audio-bytes');
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'audio/mp4' },
      audio,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(deepgramSuccess);
  });

  it('retries transient counter errors and succeeds', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    const audio = Buffer.from('fake-audio-bytes');
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'audio/mp4' },
      audio,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(deepgramSuccess);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid Content-Type with 400', async () => {
    const audio = Buffer.from('audio');
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'application/json' },
      audio,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
