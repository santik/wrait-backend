import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logRequest, logResponse } from '../src/contracts/http.js';
import { handleCleanup } from '../src/contracts/cleanup.js';
import { json } from '../src/lib/response.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  logRequest('cleanup', req);
  const result = await handleCleanup(req);
  logResponse('cleanup', result.status);
  return json(res, result.body, result.status);
}
