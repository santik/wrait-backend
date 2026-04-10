import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from '../src/lib/response.js';

export default function handler(req: VercelRequest, res: VercelResponse): void {
  json(res, { message: 'Hello, World!' });
}
