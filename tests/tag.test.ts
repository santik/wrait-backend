import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/tag.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      upsert: vi.fn(),
    },
    callCount: {
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
  body?: unknown,
) {
  const bodyBuffer =
    body instanceof Buffer ? body : body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
  const chunks = bodyBuffer ? [bodyBuffer] : [];
  let idx = 0;
  return {
    method,
    headers,
    url: '/api/tag',
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

const validBody = {
  text: 'Today I went for a long run in the park and felt great afterwards.',
  tags: ['exercise', 'nature', 'mood', 'work', 'food', 'travel'],
};

const typesafeSuccess = {
  model: 'jev-1.13.0',
  answers: {
    tags: {
      type: 'choice',
      choice: 'exercise',
      probabilities: {
        exercise: 0.72,
        nature: 0.41,
        mood: 0.55,
        work: 0.02,
        food: 0.03,
        travel: 0.01,
      },
      confidence: 0.85,
    },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};

describe('POST /api/tag', () => {
  beforeEach(() => {
    vi.stubEnv('PROXY_SECRET', 'test-secret');
    vi.stubEnv('TYPESAFE_API_KEY', 'ts-test-key');
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(prisma.device.upsert).mockResolvedValue({
      deviceId: 'a'.repeat(64),
      registeredAt: new Date(),
      dailyRecordLimit: null,
    });
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(typesafeSuccess),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 405 for non-POST method', async () => {
    const req = mockReq('GET', validHeaders);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(405);
  });

  it('returns 401 for missing proxy secret', async () => {
    const req = mockReq('POST', { ...validHeaders, 'x-proxy-secret': 'wrong' });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(401);
  });

  it('returns 400 for invalid device ID', async () => {
    const req = mockReq('POST', { ...validHeaders, 'x-device-id': 'short' });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
  });

  it('returns 400 for invalid Content-Type', async () => {
    const req = mockReq('POST', { ...validHeaders, 'content-type': 'text/plain' });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Invalid Content-Type' });
  });

  it('returns 413 for oversized body', async () => {
    const oversized = Buffer.alloc(256 * 1024 + 1, 'x');
    const req = mockReq('POST', validHeaders, oversized);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(413);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = mockReq('POST', validHeaders, Buffer.from('not json'));
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 for missing text', async () => {
    const req = mockReq('POST', validHeaders, { tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Missing or empty text' });
  });

  it('returns 400 for empty text', async () => {
    const req = mockReq('POST', validHeaders, { text: '   ', tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Missing or empty text' });
  });

  it('returns 400 for text exceeding 10000 UTF-8 bytes', async () => {
    const req = mockReq('POST', validHeaders, { text: 'x'.repeat(10001), tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({
      error: 'Text exceeds maximum length of 10000 UTF-8 bytes',
    });
  });

  it('returns 400 for multi-byte text exceeding 10000 UTF-8 bytes', async () => {
    // Each emoji is 4 UTF-8 bytes; 2501 emojis = 10004 bytes > 10000
    const req = mockReq('POST', validHeaders, { text: '\u{1F600}'.repeat(2501), tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
  });

  it('accepts multi-byte text within 10000 UTF-8 bytes', async () => {
    // 2500 emojis = 10000 bytes, exactly at limit
    const req = mockReq('POST', validHeaders, { text: '\u{1F600}'.repeat(2500), tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(200);
  });

  it('returns 400 for missing tags', async () => {
    const req = mockReq('POST', validHeaders, { text: 'hello world' });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Missing or invalid tags' });
  });

  it('returns 400 for fewer than 2 tags', async () => {
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['one'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'At least 2 tags required' });
  });

  it('returns 400 for more than 50 tags', async () => {
    const tags = Array.from({ length: 51 }, (_, i) => `tag${i}`);
    const req = mockReq('POST', validHeaders, { text: 'hello', tags });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'At most 50 tags allowed' });
  });

  it('returns 400 for duplicate tags', async () => {
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['same', 'same'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Duplicate tags are not allowed' });
  });

  it('returns 400 for empty string in tags', async () => {
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['a', ''] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Each tag must be a non-empty string' });
  });

  it('returns 400 for non-string items in tags', async () => {
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['a', 123] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Each tag must be a non-empty string' });
  });

  it('returns 400 for unknown fields', async () => {
    const req = mockReq('POST', validHeaders, { ...validBody, extra: true });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Unknown field: extra' });
  });

  it('returns 500 for missing TYPESAFE_API_KEY', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(500);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Configuration error' });
  });

  it('returns 429 when daily quota exceeded', async () => {
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue({
      deviceId: 'a'.repeat(64),
      date: new Date(),
      type: 'TAG',
      count: 3,
    });
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(429);
  });

  it('returns 502 for TypeSafe non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(502);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'upstream_error' });
  });

  it('returns 502 for TypeSafe invalid JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new Error('invalid json')),
    });
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(502);
  });

  it('returns 502 for unexpected response shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ answers: {} }),
    });
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(502);
  });

  it('returns 504 for TypeSafe timeout', async () => {
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(504);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'TypeSafe request timeout' });
  });

  it('returns 502 for network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(502);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'upstream_error' });
  });

  it('returns 200 with sorted probabilities on success', async () => {
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    const result = res as unknown as MockResShape;
    expect(result.statusCode).toBe(200);

    const body = result.body as { tags: Array<{ tag: string; probability: number }> };
    expect(body.tags).toHaveLength(6);
    expect(body.tags[0].tag).toBe('exercise');
    expect(body.tags[0].probability).toBe(0.72);
    expect(body.tags[1].tag).toBe('mood');
    expect(body.tags[1].probability).toBe(0.55);

    for (let i = 1; i < body.tags.length; i++) {
      expect(body.tags[i].probability).toBeLessThanOrEqual(body.tags[i - 1].probability);
    }
  });

  it('sends correct request to TypeSafe API', async () => {
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options.method).toBe('POST');

    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ts-test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const sentBody = JSON.parse(options.body as string) as {
      state: string;
      model: string;
      questions: { tags: { type: string; instructions: string; criteria: Record<string, null> } };
    };
    expect(sentBody.state).toBe(validBody.text);
    expect(sentBody.model).toBe('jev-latest');
    expect(sentBody.questions.tags.type).toBe('choice');
    expect(Object.keys(sentBody.questions.tags.criteria)).toEqual(validBody.tags);
    for (const val of Object.values(sentBody.questions.tags.criteria)) {
      expect(val).toBeNull();
    }
  });

  it('does not log text or tag values', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);

    for (const call of consoleSpy.mock.calls) {
      const logStr = JSON.stringify(call);
      expect(logStr).not.toContain(validBody.text);
      for (const tag of validBody.tags) {
        expect(logStr).not.toContain(`"${tag}"`);
      }
    }
  });

  it('sets Cache-Control: no-store header', async () => {
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).headers['Cache-Control']).toBe('no-store');
  });

  it('accepts exactly 2 tags (minimum)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          answers: {
            tags: {
              type: 'choice',
              choice: 'a',
              probabilities: { a: 0.6, b: 0.4 },
              confidence: 0.9,
            },
          },
        }),
    });
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(200);
  });

  it('accepts exactly 50 tags (maximum)', async () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    const probs: Record<string, number> = {};
    for (const t of tags) probs[t] = 0.02;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          answers: {
            tags: {
              type: 'choice',
              choice: 'tag0',
              probabilities: probs,
              confidence: 0.5,
            },
          },
        }),
    });
    const req = mockReq('POST', validHeaders, { text: 'hello', tags });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(200);
  });

  it('returns 400 for tag exceeding 100 characters', async () => {
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['a', 'b'.repeat(101)] });
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({
      error: 'Tag exceeds maximum length of 100 characters',
    });
  });

  it('returns 400 for missing Content-Type header', async () => {
    const headers = {
      'x-proxy-secret': validHeaders['x-proxy-secret'],
      'x-device-id': validHeaders['x-device-id'],
    };
    const req = mockReq('POST', headers);
    const res = mockRes();
    await handler(req, res);
    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expect((res as unknown as MockResShape).body).toEqual({ error: 'Invalid Content-Type' });
  });

  it('fills missing tags with probability 0 when TypeSafe omits them', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          answers: {
            tags: {
              type: 'choice',
              choice: 'exercise',
              probabilities: { exercise: 0.8, mood: 0.2 },
              confidence: 0.9,
            },
          },
        }),
    });
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    const result = res as unknown as MockResShape;
    expect(result.statusCode).toBe(200);

    const body = result.body as { tags: Array<{ tag: string; probability: number }> };
    expect(body.tags).toHaveLength(6);
    const missingTags = body.tags.filter((t) => !['exercise', 'mood'].includes(t.tag));
    for (const t of missingTags) {
      expect(t.probability).toBe(0);
    }
  });

  it('clamps out-of-range probabilities to 0', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          answers: {
            tags: {
              type: 'choice',
              choice: 'a',
              probabilities: { a: 1.5, b: -0.3 },
              confidence: 0.5,
            },
          },
        }),
    });
    const req = mockReq('POST', validHeaders, { text: 'hello', tags: ['a', 'b'] });
    const res = mockRes();
    await handler(req, res);
    const result = res as unknown as MockResShape;
    expect(result.statusCode).toBe(200);

    const body = result.body as { tags: Array<{ tag: string; probability: number }> };
    for (const t of body.tags) {
      expect(t.probability).toBe(0);
    }
  });

  it('succeeds without quota when quota persistence fails', async () => {
    vi.mocked(prisma.$executeRaw).mockRejectedValue(new Error('db timeout'));
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    const result = res as unknown as MockResShape;
    expect(result.statusCode).toBe(200);

    const body = result.body as { tags: Array<{ tag: string; probability: number }>; quota?: unknown };
    expect(body.tags).toHaveLength(6);
    expect(body.quota).toBeUndefined();
  });

  it('includes quota in response when quota persistence succeeds', async () => {
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);
    const result = res as unknown as MockResShape;
    expect(result.statusCode).toBe(200);

    const body = result.body as { quota?: { limit: number; count: number; remaining: number; resetAt: string } };
    expect(body.quota).toBeDefined();
    expect(body.quota!.count).toBe(1);
  });

  it('uses ensuredDevice.deviceId for quota increment', async () => {
    const req = mockReq('POST', validHeaders, validBody);
    const res = mockRes();
    await handler(req, res);

    const rawCall = vi.mocked(prisma.$executeRaw).mock.calls[0];
    expect(rawCall).toBeDefined();
    const rawCallStr = JSON.stringify(rawCall);
    expect(rawCallStr).toContain('a'.repeat(64));
  });
});
