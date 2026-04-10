import { describe, it, expect } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/hello.js';

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

describe('GET /api/hello', () => {
  it('returns 200 with a message', () => {
    const req = {} as VercelRequest;
    const res = mockRes();

    handler(req, res);

    const r = res as unknown as { statusCode: number; body: unknown; headers: Record<string, string> };
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ message: 'Hello, World!' });
    expect(r.headers['Cache-Control']).toBe('no-store');
  });
});
