import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logRequest, logResponse } from '../src/contracts/http.js';
import { handleTranscribe } from '../src/contracts/transcribe.js';
import { json } from '../src/lib/response.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  logRequest('transcribe', req);
  const result = await handleTranscribe(req);
  logResponse('transcribe', result.status);
  return json(res, result.body, result.status);
}
