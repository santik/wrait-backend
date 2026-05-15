import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleRegister } from '../src/contracts/register.js';
import { json } from '../src/lib/response.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const result = await handleRegister(req);
  return json(res, result.body, result.status);
}
