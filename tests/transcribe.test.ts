import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/transcribe.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
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

type MultipartPart = {
  name: string;
  body: Buffer | string;
  filename?: string;
  contentType?: string;
};

function mockReq(
  method: string,
  headers: Record<string, string>,
  body?: Buffer,
  url = '/api/transcribe',
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

function buildMultipartBody(parts: MultipartPart[], boundary = 'test-boundary'): Buffer {
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));

    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      disposition += `; filename="${part.filename}"`;
    }
    chunks.push(Buffer.from(`${disposition}\r\n`));

    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }

    chunks.push(Buffer.from('\r\n'));
    chunks.push(typeof part.body === 'string' ? Buffer.from(part.body) : part.body);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function audioPart(body: Buffer, contentType = 'audio/mp4'): MultipartPart {
  return {
    name: 'audio',
    filename: 'recording.bin',
    contentType,
    body,
  };
}

function mockMultipartReq(
  headers: Record<string, string>,
  parts: MultipartPart[],
  url = '/api/transcribe',
  boundary = 'test-boundary',
) {
  return mockReq(
    'POST',
    {
      ...headers,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    buildMultipartBody(parts, boundary),
    url,
  );
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

const expectedSuccessBody = {
  transcript: 'hello world',
  detected_language: 'en',
};

describe('POST /api/transcribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    process.env.PROXY_SECRET = 'test-secret';
    process.env.DEEPGRAM_API_KEY = 'dg-test-key';
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ deviceId: 'a'.repeat(64) } as never);
    vi.mocked(prisma.device.upsert).mockResolvedValue({
      deviceId: 'a'.repeat(64),
      registeredAt: new Date(),
    } as never);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(prisma.device.upsert).not.toHaveBeenCalled();
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
    expect(prisma.device.upsert).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('auto-registers unregistered device and continues', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('fake-audio-bytes'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(expectedSuccessBody);
    expect(prisma.device.upsert).toHaveBeenCalledWith({
      where: { deviceId: 'a'.repeat(64) },
      update: {},
      create: { deviceId: 'a'.repeat(64) },
    });
    expect(logSpy).toHaveBeenCalledWith(
      '[transcribe] Auto-registered device',
      { deviceId: 'a'.repeat(64) },
    );
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('returns 500 when device lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.device.findUnique).mockRejectedValue(new Error('DB down'));
    const req = mockReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': 'a'.repeat(64),
      'content-type': 'multipart/form-data; boundary=test-boundary',
    });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Internal server error' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.device.upsert).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('proxies audio to Deepgram and returns normalized response on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });

    const audio = Buffer.from('fake-audio-bytes');
    const deviceId = 'a'.repeat(64);
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': deviceId },
      [audioPart(audio, 'audio/mp4')],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(expectedSuccessBody);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain('https://api.deepgram.com/v1/listen');
    expect(url).toContain('model=nova-3-general');
    expect(url).toContain('detect_language=true');
    expect(url).toContain('utterances=false');
    expect(url).toContain('filler_words=true');
    expect(url).toContain('punctuate=true');
    expect(url).toContain('smart_format=true');
    expect(init.headers.Authorization).toBe('Token dg-test-key');
    expect(init.headers['Content-Type']).toBe('audio/mp4');
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe(audio.toString());
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

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('bad-audio'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual(dgError);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('ignores incoming query parameters and uses backend defaults', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => deepgramSuccess });

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
      '/api/transcribe?model=custom&language=nl&detect_language=false&utterances=true&filler_words=false&punctuate=false&smart_format=false',
    );
    const res = mockRes();

    await handler(req, res);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3-general&detect_language=true&utterances=false&filler_words=true&punctuate=true&smart_format=true',
    );
  });

  it('uses backend default query parameters when only an audio part is provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => deepgramSuccess });

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
    );
    const res = mockRes();

    await handler(req, res);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.deepgram.com/v1/listen?model=nova-3-general&detect_language=true&utterances=false&filler_words=true&punctuate=true&smart_format=true',
    );
    expect((res as unknown as MockResShape).statusCode).toBe(200);
    expect((res as unknown as MockResShape).body).toEqual(expectedSuccessBody);
  });

  it('uses the uploaded file content type when forwarding to Deepgram', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => deepgramSuccess });

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'), 'audio/webm')],
    );
    const res = mockRes();

    await handler(req, res);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers['Content-Type']).toBe('audio/webm');
    expect((res as unknown as MockResShape).body).toEqual(expectedSuccessBody);
  });

  it('rejects requests exceeding size limit with 413', async () => {
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.alloc(26 * 1024 * 1024))],
    );
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

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'Invalid response from upstream' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when fetch throws network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
    );
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

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('fake-audio-bytes'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(expectedSuccessBody);
  });

  it('retries transient counter errors and succeeds', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('fake-audio-bytes'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual(expectedSuccessBody);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('returns 502 when Deepgram success payload is missing transcript fields', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: { channels: [{ alternatives: [] }] } }),
    });

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'Invalid response from upstream' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when Deepgram success payload is missing detected language', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: 'hello world' }] }] },
      }),
    });

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'Invalid response from upstream' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('stores counter in UTC day bucket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T23:59:59.123Z'));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });

    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('fake-audio-bytes'))],
    );
    const res = mockRes();

    await handler(req, res);

    const dateArg = vi.mocked(prisma.$executeRaw).mock.calls[0][2] as Date;
    expect(dateArg).toBeInstanceOf(Date);
    expect(dateArg.toISOString()).toBe('2026-04-17T00:00:00.000Z');
  });

  it('uses separate counter buckets on different days', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => deepgramSuccess,
    });

    const makeReq = () =>
      mockMultipartReq(
        { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
        [audioPart(Buffer.from('fake-audio-bytes'))],
      );

    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));
    await handler(makeReq(), mockRes());

    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'));
    await handler(makeReq(), mockRes());

    const firstDateArg = vi.mocked(prisma.$executeRaw).mock.calls[0][2] as Date;
    const secondDateArg = vi.mocked(prisma.$executeRaw).mock.calls[1][2] as Date;

    expect(firstDateArg.toISOString()).toBe('2026-04-17T00:00:00.000Z');
    expect(secondDateArg.toISOString()).toBe('2026-04-18T00:00:00.000Z');
    expect(firstDateArg.toISOString()).not.toBe(secondDateArg.toISOString());
  });

  it('rejects non-multipart Content-Type with 400', async () => {
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'audio/mp4' },
      Buffer.from('audio'),
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects multipart requests without a boundary parameter', async () => {
    const req = mockReq(
      'POST',
      {
        'x-proxy-secret': 'test-secret',
        'x-device-id': 'a'.repeat(64),
        'content-type': 'multipart/form-data',
      },
      Buffer.from('audio'),
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects multipart requests with an empty boundary parameter', async () => {
    const req = mockReq(
      'POST',
      {
        'x-proxy-secret': 'test-secret',
        'x-device-id': 'a'.repeat(64),
        'content-type': 'multipart/form-data; boundary=',
      },
      Buffer.from('audio'),
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects multipart requests with an overly long boundary parameter', async () => {
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'))],
      '/api/transcribe',
      'a'.repeat(71),
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects multipart requests without an audio file', async () => {
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing audio file' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unexpected multipart form fields', async () => {
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [{ name: 'note', body: 'not audio' }],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid multipart form data' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects multipart requests with multiple audio files', async () => {
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio-1')), audioPart(Buffer.from('audio-2'), 'audio/wav')],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Multiple audio files not supported' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported audio file content types with 400', async () => {
    const req = mockMultipartReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [audioPart(Buffer.from('audio'), 'application/octet-stream')],
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid audio Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
