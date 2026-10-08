import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logRequest, logResponse } from '../src/contracts/http.js';
import { handleRegister } from '../src/contracts/register.js';
import { json } from '../src/lib/response.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  logRequest('register', req);
  const result = await handleRegister(req);
  logResponse('register', result.status);
  return json(res, result.body, result.status);
}
