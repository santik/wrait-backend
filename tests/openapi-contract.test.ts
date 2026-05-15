import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'yaml';
import registerHandler from '../api/register.js';
import transcribeHandler from '../api/transcribe.js';
import cleanupHandler from '../api/cleanup.js';
import { ALLOWED_LANGUAGES } from '../src/lib/allowedLanguages.js';
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
const require = createRequire(import.meta.url);
const Ajv = (require('ajv').default ?? require('ajv')) as new (options?: {
  allErrors?: boolean;
  strict?: boolean;
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

type OpenApiSpec = {
  components: {
    schemas: Record<string, unknown>;
  };
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
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

function mockCleanupReq(method: string, headers: Record<string, string>, body?: unknown) {
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
  const ajv = new Ajv({ allErrors: true, strict: false });
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
    expectToMatchSchema(getResponseSchema(spec, '/api/register', 'post', 201), (res as unknown as MockResShape).body);
  });

  it('register unauthorized error matches the OpenAPI 401 response schema', async () => {
    const req = mockRegisterReq('POST', { 'x-device-id': 'a'.repeat(64) });
    const res = mockRes();

    await registerHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(401);
    expectToMatchSchema(getResponseSchema(spec, '/api/register', 'post', 401), (res as unknown as MockResShape).body);
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

    const req = mockTranscribeReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'audio/mp4' },
      Buffer.from('audio'),
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(200);
    expectToMatchSchema(getResponseSchema(spec, '/api/transcribe', 'post', 200), (res as unknown as MockResShape).body);
  });

  it('transcribe upstream failure matches the OpenAPI 502 response schema', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Bad Request', reason: 'invalid audio' }),
    });

    const req = mockTranscribeReq(
      'POST',
      { 'x-proxy-secret': 'test-secret', 'x-device-id': 'a'.repeat(64), 'content-type': 'audio/mp4' },
      Buffer.from('audio'),
    );
    const res = mockRes();

    await transcribeHandler(req, res);

    expect((res as unknown as MockResShape).statusCode).toBe(502);
    expectToMatchSchema(getResponseSchema(spec, '/api/transcribe', 'post', 502), (res as unknown as MockResShape).body);
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
    expectToMatchSchema(getResponseSchema(spec, '/api/cleanup', 'post', 200), (res as unknown as MockResShape).body);
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
    expectToMatchSchema(getResponseSchema(spec, '/api/cleanup', 'post', 400), (res as unknown as MockResShape).body);
  });
});
