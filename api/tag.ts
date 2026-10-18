import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logRequest, logResponse } from '../src/contracts/http.js';
import { handleTag } from '../src/contracts/tag.js';
import { json } from '../src/lib/response.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  logRequest('tag', req);
  const result = await handleTag(req);
  logResponse('tag', result.status);
  return json(res, result.body, result.status);
}
