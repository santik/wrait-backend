import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/cleanup.js';
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

function mockReq(
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const bodyBuffer =
    body instanceof Buffer ? body : body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
  const chunks = bodyBuffer ? [bodyBuffer] : [];
  let idx = 0;
  return {
    method,
    headers,
    url: '/api/cleanup',
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (idx < chunks.length) return { value: chunks[idx++], done: false as const };
          return { value: undefined, done: true as const };
        },
      };
    },
  } as unknown as VercelRequest;
}

const validHeaders = {
  'x-proxy-secret': 'test-secret',
  'x-device-id': 'a'.repeat(64),
  'content-type': 'application/json',
};

const validBody = { transcript: 'um hello world so like', language: 'en-US' };

const openaiSuccess = {
  choices: [{ message: { content: 'Hello world.' } }],
};

describe('POST /api/cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    process.env.PROXY_SECRET = 'test-secret';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    vi.mocked(prisma.device.findUnique).mockResolvedValue({ deviceId: 'a'.repeat(64) } as never);
    vi.mocked(prisma.device.upsert).mockResolvedValue({ deviceId: 'a'.repeat(64), registeredAt: new Date() } as never);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env.OPENAI_API_KEY = 'sk-test-key';
  });

  it('rejects non-POST requests with 405', async () => {
    const req = mockReq('GET', {});
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(405);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing proxy secret with 401', async () => {
    const req = mockReq('POST', {}, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(401);
    expect(r.body).toEqual({ error: 'Unauthorized' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects wrong proxy secret with 401', async () => {
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'wrong', 'x-device-id': 'a'.repeat(64), 'content-type': 'application/json' },
      validBody,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing device ID with 400', async () => {
    const req = mockReq('POST', { 'x-proxy-secret': 'test-secret' }, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid device ID' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid device ID format with 400', async () => {
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'abc123', 'content-type': 'application/json' },
      validBody,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid device ID' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 500 when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Configuration error' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects wrong Content-Type with 400', async () => {
    const req = mockReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'text/plain' },
      validBody,
    );
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid Content-Type' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects body exceeding 1MB with 413', async () => {
    const largeBody = Buffer.alloc(2 * 1024 * 1024);
    const req = mockReq('POST', validHeaders, largeBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(413);
    expect(r.body).toEqual({ error: 'Request too large' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON body with 400', async () => {
    const req = mockReq('POST', validHeaders, Buffer.from('not valid json'));
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Invalid JSON body' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing transcript with 400', async () => {
    const req = mockReq('POST', validHeaders, { language: 'en-US' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid transcript' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects empty transcript with 400', async () => {
    const req = mockReq('POST', validHeaders, { transcript: '', language: 'en-US' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid transcript' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only transcript with 400', async () => {
    const req = mockReq('POST', validHeaders, { transcript: '   ', language: 'en-US' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid transcript' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects transcript shorter than 10 chars with 400', async () => {
    const req = mockReq('POST', validHeaders, { transcript: 'hi there', language: 'en-US' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid transcript' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects missing language with 400', async () => {
    const req = mockReq('POST', validHeaders, { transcript: 'hello world today' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid language' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects language not in allowed list with 400', async () => {
    const req = mockReq('POST', validHeaders, { transcript: 'hello world today', language: 'xx-ZZ' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid language' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid BCP-47 language with 400', async () => {
    const req = mockReq('POST', validHeaders, { transcript: 'hello world today', language: '123-invalid' });
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ error: 'Missing or invalid language' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 500 when device lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.mocked(prisma.device.findUnique).mockRejectedValue(new Error('DB down'));
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: 'Internal server error' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('auto-registers unregistered device and continues', async () => {
    vi.mocked(prisma.device.findUnique).mockResolvedValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(prisma.device.upsert).toHaveBeenCalledWith({
      where: { deviceId: 'a'.repeat(64) },
      update: {},
      create: { deviceId: 'a'.repeat(64) },
    });
    expect(logSpy).toHaveBeenCalledWith(
      '[cleanup] Auto-registered device from cleanup endpoint',
      { deviceId: 'a'.repeat(64) },
    );
  });

  it('returns cleanedText on success and increments call count', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ cleanedText: 'Hello world.', wasTruncated: false });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it('sends correct model, temperature, and max_tokens to OpenAI', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });

    await handler(mockReq('POST', validHeaders, validBody), mockRes());

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer sk-test-key');

    const sent = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.model).toBe('gpt-4o-mini');
    expect(sent.temperature).toBe(0.3);
    expect(sent.max_tokens).toBe(1024);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('en-US');
    expect(sent.messages[1].role).toBe('user');
    expect(sent.messages[1].content).toBe(validBody.transcript);
  });

  it('truncates transcript to 3000 chars and sets wasTruncated: true', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });

    const longTranscript = 'x'.repeat(5000);
    const res = mockRes();
    await handler(mockReq('POST', validHeaders, { transcript: longTranscript, language: 'en-US' }), res);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(sent.messages[1].content).toHaveLength(3000);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ cleanedText: 'Hello world.', wasTruncated: true });
  });

  it('returns 504 when OpenAI request times out', async () => {
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(504);
    expect(r.body).toEqual({ error: 'OpenAI request timeout' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when OpenAI returns non-200', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429 });

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'upstream_error' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when fetch throws network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(r.body).toEqual({ error: 'upstream_error' });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when OpenAI returns invalid JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('bad json'); },
    });

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('returns 502 when OpenAI response has unexpected shape', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(502);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('still returns 200 when call count update fails', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('DB error'));
    vi.spyOn(console, 'error').mockImplementation(() => { });

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ cleanedText: 'Hello world.', wasTruncated: false });
  });

  it('retries transient counter errors and succeeds', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });
    vi.mocked(prisma.$executeRaw)
      .mockRejectedValueOnce(new Error('connection timeout'))
      .mockResolvedValueOnce(1 as never);

    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();

    await handler(req, res);

    const r = res as unknown as MockResShape;
    expect(r.statusCode).toBe(200);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('stores counter in UTC day bucket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T23:59:59.123Z'));
    mockFetch.mockResolvedValue({ ok: true, json: async () => openaiSuccess });

    await handler(mockReq('POST', validHeaders, validBody), mockRes());

    const dateArg = vi.mocked(prisma.$executeRaw).mock.calls[0][2] as Date;
    expect(dateArg).toBeInstanceOf(Date);
    expect(dateArg.toISOString()).toBe('2026-04-17T00:00:00.000Z');
  });
});
