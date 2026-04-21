import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { json } from '../src/lib/response.js';
import { getUTCDayBucket, incrementCallCount } from '../src/lib/callCount.js';
import { ensureDevice } from '../src/lib/device.js';

export const config = { api: { bodyParser: false } };
const DEEPGRAM_TIMEOUT_MS = 55000; // 5s before Vercel timeout

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);

  if (req.headers['x-proxy-secret'] !== process.env.PROXY_SECRET)
    return json(res, { error: 'Unauthorized' }, 401);

  const deviceId = req.headers['x-device-id'];
  if (!deviceId || typeof deviceId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(deviceId)) {
    return json(res, { error: 'Invalid device ID' }, 400);
  }

  const allowedTypes = ['audio/mp4', 'audio/m4a', 'audio/wav', 'audio/webm'];
  const contentType = (req.headers['content-type'] as string) ?? 'audio/mp4';
  if (!allowedTypes.includes(contentType)) {
    console.error('[transcribe] Invalid Content-Type:', contentType);
    return json(res, { error: 'Invalid Content-Type' }, 400);
  }

  try {
    await ensureDevice(deviceId, 'transcribe');
  } catch (error) {
    console.error('[transcribe] Failed to validate device:', {
      error: error instanceof Error ? error.message : String(error),
      deviceId,
    });
    return json(res, { error: 'Internal server error' }, 500);
  }

  const MAX_SIZE = 25 * 1024 * 1024; // 25MB
  let totalSize = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > MAX_SIZE) {
      console.error('[transcribe] Request too large:', totalSize);
      return json(res, { error: 'Request too large' }, 413);
    }
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  console.log('[transcribe] Request received', {
    contentLength: totalSize,
    contentType,
    hasSecret: !!req.headers['x-proxy-secret'],
  });

  const { search } = new URL(req.url!, `https://${req.headers.host}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPGRAM_TIMEOUT_MS);

  console.log('[transcribe] Forwarding to Deepgram', { search });

  let dgRes: Response;
  try {
    dgRes = await fetch(`https://api.deepgram.com/v1/listen${search}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': contentType,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error('[transcribe] Fetch error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return json(res, { error: 'Deepgram request timeout' }, 504);
    }
    return json(res, { error: 'Failed to reach Deepgram' }, 502);
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown;
  try {
    payload = await dgRes.json();
  } catch {
    console.error('[transcribe] Invalid JSON from Deepgram');
    return json(res, { error: 'Invalid response from upstream' }, 502);
  }

  console.log('[transcribe] Deepgram response', { status: dgRes.status, ok: dgRes.ok , payload : payload.results.channels[0]});

  if (dgRes.ok) {
    await incrementCallCount(deviceId, getUTCDayBucket(), CallCountType.TRANSCRIPTION, 'transcribe');
  }

  return json(res, payload, dgRes.ok ? 200 : 502);
}
