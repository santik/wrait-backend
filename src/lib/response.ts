import type { VercelResponse } from '@vercel/node';

export function json(res: VercelResponse, data: unknown, status = 200): void {
  res.status(status).json(data);
}
