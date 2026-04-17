import type { VercelRequest, VercelResponse } from '@vercel/node';
import { json } from '../src/lib/response.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);

  if (req.headers['x-proxy-secret'] !== process.env.PROXY_SECRET)
    return json(res, { error: 'Unauthorized' }, 401);

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as ArrayBuffer));
  const body = Buffer.concat(chunks);

  const { search } = new URL(req.url!, `https://${req.headers.host}`);
  const dgRes = await fetch(`https://api.deepgram.com/v1/listen${search}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': (req.headers['content-type'] as string) ?? 'audio/mp4',
    },
    body,
  });

  const payload: unknown = await dgRes.json();
  return json(res, payload, dgRes.ok ? 200 : 502);
}
