import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleTranscribe } from '../src/contracts/transcribe.js';
import { json } from '../src/lib/response.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const result = await handleTranscribe(req);
  return json(res, result.body, result.status);
}
