import { describe, it, expect } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/hello.js';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
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

    expect((res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect((res as unknown as { body: unknown }).body).toEqual({ message: 'Hello, World!' });
  });
});
