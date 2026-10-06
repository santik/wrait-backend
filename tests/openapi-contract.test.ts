import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'yaml';
import registerHandler from '../api/register.js';
import transcribeHandler from '../api/transcribe.js';
import cleanupHandler from '../api/cleanup.js';
import { ALLOWED_LANGUAGES } from '../src/lib/allowedLanguages.js';
import { TRANSCRIPTION_LANGUAGES } from '../src/generated/transcriptionLanguages.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    callCount: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

const mockFetch = vi.fn();
const require = createRequire(import.meta.url);
const Ajv = (require('ajv').default ?? require('ajv')) as new (options?: {
  allErrors?: boolean;
  strict?: boolean;
  validateFormats?: boolean;
}) => {
  compile(schema: Record<string, unknown>): {
    (payload: unknown): boolean;
    errors?: unknown;
  };
};

type MockResShape = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
};

type MultipartPart = {
  name: string;
  body: Buffer | string;
  filename?: string;
  contentType?: string;
};

type OpenApiSpec = {
  components: {
    parameters: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: unknown[];
        responses: Record<string, unknown>;
      }
    >
  >;
};

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

function mockRegisterReq(method: string, headers: Record<string, string>) {
  return {
    method,
    headers,
  } as unknown as VercelRequest;
}

function mockTranscribeReq(
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

function mockMultipartTranscribeReq(
  headers: Record<string, string>,
  parts: MultipartPart[],
  url = '/api/transcribe',
  boundary = 'test-boundary',
) {
  return mockTranscribeReq(
    'POST',
    {
      ...headers,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    buildMultipartBody(parts, boundary),
    url,
  );
}

function mockCleanupReq(method: string, headers: Record<string, string>, body?: unknown) {
  const bodyBuffer =
    body instanceof Buffer
      ? body
      : body !== undefined
        ? Buffer.from(JSON.stringify(body))
        : undefined;
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

function getSpec(): OpenApiSpec {
  const raw = readFileSync(new URL('../openapi/openapi.yaml', import.meta.url), 'utf8');
  return parse(raw) as OpenApiSpec;
}

function getByPath(source: unknown, ref: string): unknown {
  const path = ref.replace(/^#\//, '').split('/');
  let current = source;

  for (const segment of path) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`Unable to resolve OpenAPI ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function resolveRefs(source: unknown, node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(source, item));
  }

  if (!node || typeof node !== 'object') {
    return node;
  }

  if ('$ref' in node) {
    return resolveRefs(source, getByPath(source, (node as { $ref: string }).$ref));
  }

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, resolveRefs(source, value)]),
  );
}

function getResponseSchema(
  spec: OpenApiSpec,
  path: '/api/register' | '/api/transcribe' | '/api/cleanup',
  method: 'post',
  status: number,
): Record<string, unknown> {
  const response = spec.paths[path][method].responses[String(status)];
  const resolvedResponse = resolveRefs(spec, response) as {
    content?: { 'application/json'?: { schema?: Record<string, unknown> } };
  };
  const schema = resolvedResponse.content?.['application/json']?.schema;

  if (!schema) {
    throw new Error(`Missing JSON schema for ${method.toUpperCase()} ${path} ${status}`);
  }

  return schema;
}

function expectToMatchSchema(schema: Record<string, unknown>, payload: unknown): void {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  const valid = validate(payload);

  expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

const spec = getSpec();

describe('OpenAPI contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    process.env.PROXY_SECRET = 'test-secret';
    process.env.DEEPGRAM_API_KEY = 'dg-test-key';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    vi.mocked(prisma.device.upsert).mockResolvedValue({
      deviceId: 'a'.repeat(64),
      registeredAt: new Date(),
      dailyRecordLimit: null,
    } as never);
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the cleanup language enum synchronized with ALLOWED_LANGUAGES', () => {
    const cleanupSchema = spec.components.schemas.CleanupRequest as {
      properties?: { language?: { enum?: string[] } };
    };
    const specLanguages = [...(cleanupSchema.properties?.language?.enum ?? [])].sort();
    const codeLanguages = [...ALLOWED_LANGUAGES].sort();

    expect(specLanguages).toEqual(codeLanguages);
  });

  it('register success matches the OpenAPI 201 response schema', async () => {
    const req = mockRegisterReq('POST', {
      'x-proxy-secret': 'test-secret',
      'x-device-id': 'a'.repeat(64),
    });
    const res = mockRes();

    await registerHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(201);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/register', 'post', 201),
      (res as unknown as MockResShape).body,
    );
  });

  it('register unauthorized error matches the OpenAPI 401 response schema', async () => {
    const req = mockRegisterReq('POST', { 'x-device-id': 'a'.repeat(64) });
    const res = mockRes();

    await registerHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(401);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/register', 'post', 401),
      (res as unknown as MockResShape).body,
    );
  });

  it('transcribe success matches the OpenAPI 200 response schema', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: {
          channels: [
            {
              alternatives: [{ transcript: 'hello world' }],
              detected_language: 'en',
            },
          ],
        },
      }),
    });

    const req = mockMultipartTranscribeReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [
        {
          name: 'audio',
          filename: 'recording.m4a',
          contentType: 'audio/m4a',
          body: Buffer.from('audio'),
        },
      ],
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(200);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/transcribe', 'post', 200),
      (res as unknown as MockResShape).body,
    );
  });

  it('documents and validates the optional transcription language query parameter', () => {
    const operation = spec.paths['/api/transcribe'].post;
    const parameters = resolveRefs(spec, operation.parameters) as Array<{
      name?: string;
      in?: string;
      required?: boolean;
      schema?: Record<string, unknown>;
    }>;
    const language = parameters.find((parameter) => parameter.name === 'language');

    expect(language).toMatchObject({ name: 'language', in: 'query', required: false });
    const languageSchema = language!.schema as Record<string, unknown> & { enum?: string[] };
    expect(languageSchema.enum).toEqual([...TRANSCRIPTION_LANGUAGES]);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(languageSchema);

    for (const value of ['it', 'nl', 'en-US', 'multi', 'zh-Hans', 'zh-Hant']) {
      expect(validate(value), value).toBe(true);
    }
    for (const value of ['', 'IT', 'en-us', 'en_US', 'eng', 'zzz', 'it ', 'it\n']) {
      expect(validate(value), value).toBe(false);
    }
  });

  it('explicit-language transcribe success matches the OpenAPI 200 response schema', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: 'buongiorno' }] }] },
      }),
    });
    const req = mockMultipartTranscribeReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [
        {
          name: 'audio',
          filename: 'recording.m4a',
          contentType: 'audio/m4a',
          body: Buffer.from('audio'),
        },
      ],
      '/api/transcribe?language=it',
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(200);
    expect((res as unknown as MockResShape).body).toMatchObject({ detected_language: 'it' });
    expectToMatchSchema(
      getResponseSchema(spec, '/api/transcribe', 'post', 200),
      (res as unknown as MockResShape).body,
    );
  });

  it.each([
    ['/api/transcribe?language=de', { language: 'de' }],
    ['/api/transcribe', {}],
  ])('empty transcript at %s matches the OpenAPI 422 response schema', async (url, extra) => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: '' }], detected_language: 'en' }] },
      }),
    });
    const req = mockMultipartTranscribeReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [
        {
          name: 'audio',
          filename: 'recording.m4a',
          contentType: 'audio/m4a',
          body: Buffer.from('audio'),
        },
      ],
      url,
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    const { statusCode, body } = res as unknown as MockResShape;
    expect(statusCode).toBe(422);
    expect(body).toEqual({
      error: 'Speech could not be recognized',
      reason: 'speech_not_recognized',
      ...extra,
    });
    const schema = getResponseSchema(spec, '/api/transcribe', 'post', 422);
    expectToMatchSchema(schema, body);
    expect(() => expectToMatchSchema(schema, { ...(body as object), reason: 'other' })).toThrow();
  });

  it('invalid transcription language matches the OpenAPI 400 response schema', async () => {
    const req = mockMultipartTranscribeReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [
        {
          name: 'audio',
          filename: 'recording.m4a',
          contentType: 'audio/m4a',
          body: Buffer.from('audio'),
        },
      ],
      '/api/transcribe?language=IT',
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/transcribe', 'post', 400),
      (res as unknown as MockResShape).body,
    );
  });

  it('transcribe upstream failure matches the OpenAPI 502 response schema', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Bad Request', reason: 'invalid audio' }),
    });

    const req = mockMultipartTranscribeReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [
        {
          name: 'audio',
          filename: 'recording.m4a',
          contentType: 'audio/m4a',
          body: Buffer.from('audio'),
        },
      ],
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(502);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/transcribe', 'post', 502),
      (res as unknown as MockResShape).body,
    );
  });

  it('transcribe quota-exceeded error matches the OpenAPI 429 response schema', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:00:00.000Z'));
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue({ count: 6 } as never);

    const req = mockMultipartTranscribeReq(
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64) },
      [
        {
          name: 'audio',
          filename: 'recording.m4a',
          contentType: 'audio/m4a',
          body: Buffer.from('audio'),
        },
      ],
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(429);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/transcribe', 'post', 429),
      (res as unknown as MockResShape).body,
    );
  });

  it('cleanup success matches the OpenAPI 200 response schema', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Hello world.' } }] }),
    });

    const req = mockCleanupReq(
      'POST',
      {
        'x-proxy-secret': 'test-secret',
        'x-device-id': 'a'.repeat(64),
        'content-type': 'application/json',
      },
      { transcript: 'um hello world so like', language: 'en-US' },
    );
    const res = mockRes();

    await cleanupHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(200);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/cleanup', 'post', 200),
      (res as unknown as MockResShape).body,
    );
  });

  it('cleanup invalid-content-type error matches the OpenAPI 400 response schema', async () => {
    const req = mockCleanupReq(
      'POST',
      {
        'x-proxy-secret': 'test-secret',
        'x-device-id': 'a'.repeat(64),
        'content-type': 'text/plain',
      },
      { transcript: 'um hello world so like', language: 'en-US' },
    );
    const res = mockRes();

    await cleanupHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(400);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/cleanup', 'post', 400),
      (res as unknown as MockResShape).body,
    );
  });

  it('cleanup quota-exceeded error matches the OpenAPI 429 response schema', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T10:00:00.000Z'));
    vi.mocked(prisma.callCount.findUnique).mockResolvedValue({ count: 3 } as never);

    const req = mockCleanupReq(
      'POST',
      {
        'x-proxy-secret': 'test-secret',
        'x-device-id': 'a'.repeat(64),
        'content-type': 'application/json',
      },
      { transcript: 'um hello world so like', language: 'en-US' },
    );
    const res = mockRes();

    await cleanupHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(429);
    expectToMatchSchema(
      getResponseSchema(spec, '/api/cleanup', 'post', 429),
      (res as unknown as MockResShape).body,
    );
  });
});
