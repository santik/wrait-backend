import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { ensureDevice } from '../lib/device.js';
import { getUTCDayBucket, incrementCallCount } from '../lib/callCount.js';
import {
  errorResponse,
  readRequestBody,
  requireDeviceId,
  requirePostMethod,
  requireProxySecret,
} from './http.js';
import type { OperationResult } from './http.js';
import type {
  TranscribeResponseBody,
  UpstreamErrorResponse,
} from './openapi.js';

const DEEPGRAM_TIMEOUT_MS = 55000;
const MAX_REQUEST_SIZE = 25 * 1024 * 1024;

export const ALLOWED_AUDIO_CONTENT_TYPES = [
  'audio/mp4',
  'audio/m4a',
  'audio/wav',
  'audio/webm',
] as const;

type SupportedAudioContentType = (typeof ALLOWED_AUDIO_CONTENT_TYPES)[number];

const DEFAULT_TRANSCRIBE_QUERY = {
  model: 'nova-3-general',
  detect_language: true,
  utterances: false,
  filler_words: true,
  punctuate: true,
  smart_format: true,
} as const;

function getSupportedContentType(req: VercelRequest): SupportedAudioContentType | null {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string') {
    return 'audio/mp4';
  }

  return ALLOWED_AUDIO_CONTENT_TYPES.includes(contentType as SupportedAudioContentType)
    ? (contentType as SupportedAudioContentType)
    : null;
}

function buildDeepgramSearch(): string {
  const searchParams = new URLSearchParams();

  for (const [name, value] of Object.entries(DEFAULT_TRANSCRIBE_QUERY)) {
    searchParams.set(name, String(value));
  }

  const search = searchParams.toString();
  return search ? `?${search}` : '';
}

function getDeepgramChannel(payload: unknown): { transcript: string; detectedLanguage: string } | null {
  if (!payload || typeof payload !== 'object') return null;

  const results = (payload as { results?: unknown }).results;
  if (!results || typeof results !== 'object') return null;

  const channels = (results as { channels?: unknown }).channels;
  if (!Array.isArray(channels) || channels.length === 0) return null;

  const firstChannel = channels[0] as { alternatives?: unknown; detected_language?: unknown };
  const alternatives = firstChannel.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  const transcript = (alternatives[0] as { transcript?: unknown }).transcript;
  const detectedLanguage = firstChannel.detected_language;

  if (typeof transcript !== 'string' || typeof detectedLanguage !== 'string') {
    return null;
  }

  return { transcript, detectedLanguage };
}

export async function handleTranscribe(
  req: VercelRequest,
): Promise<OperationResult<TranscribeResponseBody, UpstreamErrorResponse>> {
  const methodError = requirePostMethod(req);
  if (methodError) return methodError;

  const authError = requireProxySecret(req);
  if (authError) return authError;

  const device = requireDeviceId(req);
  if ('status' in device) return device;

  const contentType = getSupportedContentType(req);
  if (!contentType) {
    console.error('[transcribe] Invalid Content-Type:', req.headers['content-type']);
    return { status: 400, body: errorResponse('Invalid Content-Type') };
  }

  try {
    await ensureDevice(device.deviceId, 'transcribe');
  } catch (error) {
    console.error('[transcribe] Failed to validate device:', {
      error: error instanceof Error ? error.message : String(error),
      deviceId: device.deviceId,
    });
    return { status: 500, body: errorResponse('Internal server error') };
  }

  const requestBody = await readRequestBody(req, MAX_REQUEST_SIZE);
  if ('status' in requestBody) return requestBody;

  console.log('[transcribe] Request received', {
    contentLength: requestBody.totalSize,
    contentType,
    hasSecret: !!req.headers['x-proxy-secret'],
  });

  const search = buildDeepgramSearch();

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
      body: new Uint8Array(requestBody.body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error('[transcribe] Fetch error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 504, body: errorResponse('Deepgram request timeout') };
    }
    return { status: 502, body: errorResponse('Failed to reach Deepgram') };
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown;
  try {
    payload = await dgRes.json();
  } catch {
    console.error('[transcribe] Invalid JSON from Deepgram');
    return { status: 502, body: errorResponse('Invalid response from upstream') };
  }

  const deepgramChannel = getDeepgramChannel(payload);

  console.log('[transcribe] Deepgram response', {
    status: dgRes.status,
    ok: dgRes.ok,
    payload: deepgramChannel?.transcript,
  });

  if (dgRes.ok) {
    if (!deepgramChannel) {
      console.error('[transcribe] Unexpected Deepgram response shape');
      return { status: 502, body: errorResponse('Invalid response from upstream') };
    }
    await incrementCallCount(device.deviceId, getUTCDayBucket(), CallCountType.TRANSCRIPTION, 'transcribe');
  }

  return {
    status: dgRes.ok ? 200 : 502,
    body: dgRes.ok
      ? {
          transcript: deepgramChannel!.transcript,
          detected_language: deepgramChannel!.detectedLanguage,
        }
      : (payload as UpstreamErrorResponse),
  };
}
