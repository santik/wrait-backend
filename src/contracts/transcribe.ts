import { once } from 'node:events';
import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import busboy from 'busboy';
import { ensureDevice } from '../lib/device.js';
import { getUTCDayBucket, incrementCallCount } from '../lib/callCount.js';
import {
  errorResponse,
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
const MAX_MULTIPART_PARTS = 10;
const BOUNDARY_MAX_LENGTH = 70;
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=?]+$/;

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

type MultipartAudioUpload = {
  body: Buffer;
  contentType: SupportedAudioContentType;
  requestSize: number;
};

function getMultipartContentType(req: VercelRequest): { contentType: string; boundary: string } | null {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string') {
    return null;
  }

  const [mediaType, ...rawParameters] = contentType.split(';');
  if (mediaType.trim().toLowerCase() !== 'multipart/form-data') {
    return null;
  }

  let boundary: string | null = null;
  for (const rawParameter of rawParameters) {
    const [rawName, ...rawValueParts] = rawParameter.split('=');
    if (rawValueParts.length === 0 || rawName.trim().toLowerCase() !== 'boundary') {
      continue;
    }

    let rawValue = rawValueParts.join('=').trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      rawValue = rawValue.slice(1, -1);
    }
    boundary = rawValue;
    break;
  }

  if (!boundary || boundary.length > BOUNDARY_MAX_LENGTH || !BOUNDARY_PATTERN.test(boundary)) {
    return null;
  }

  return { contentType, boundary };
}

function getSupportedAudioContentType(contentType: string): SupportedAudioContentType | null {
  return ALLOWED_AUDIO_CONTENT_TYPES.includes(contentType as SupportedAudioContentType)
    ? (contentType as SupportedAudioContentType)
    : null;
}

async function parseMultipartAudioUpload(
  req: VercelRequest,
  requestContentType: string,
): Promise<MultipartAudioUpload | OperationResult<never>> {
  const parser = busboy({
    headers: {
      ...req.headers,
      'content-type': requestContentType,
    },
    limits: {
      fields: 0,
      files: 2,
      parts: MAX_MULTIPART_PARTS,
      fileSize: MAX_REQUEST_SIZE,
    },
  });

  const audioChunks: Buffer[] = [];
  let audioContentType: SupportedAudioContentType | null = null;
  let audioFileCount = 0;
  let audioSize = 0;
  let requestSize = 0;
  let aborted = false;
  let pendingError: OperationResult<never> | null = null;

  const setError = (result: OperationResult<never>) => {
    if (!pendingError) {
      pendingError = result;
    }
  };

  parser.on('field', () => {
    setError({ status: 400, body: errorResponse('Invalid multipart form data') });
  });

  parser.on('partsLimit', () => {
    setError({ status: 400, body: errorResponse('Invalid multipart form data') });
  });

  parser.on('filesLimit', () => {
    setError({ status: 400, body: errorResponse('Invalid multipart form data') });
  });

  parser.on('fieldsLimit', () => {
    setError({ status: 400, body: errorResponse('Invalid multipart form data') });
  });

  parser.on('file', (name, stream, info) => {
    if (name !== 'audio') {
      setError({ status: 400, body: errorResponse('Invalid multipart form data') });
      stream.resume();
      return;
    }

    audioFileCount += 1;
    if (audioFileCount > 1) {
      setError({ status: 400, body: errorResponse('Multiple audio files not supported') });
      stream.resume();
      return;
    }

    const contentType = getSupportedAudioContentType(info.mimeType);
    if (!contentType) {
      console.error('[transcribe] Invalid audio Content-Type:', info.mimeType || '(missing)');
      setError({ status: 400, body: errorResponse('Invalid audio Content-Type') });
      stream.resume();
      return;
    }

    audioContentType = contentType;

    stream.on('limit', () => {
      setError({ status: 413, body: errorResponse('Request too large') });
    });

    stream.on('data', (chunk: Buffer) => {
      audioSize += chunk.length;
      audioChunks.push(Buffer.from(chunk));
    });
  });

  return await new Promise<MultipartAudioUpload | OperationResult<never>>(async (resolve) => {
    let settled = false;

    const finish = (result: MultipartAudioUpload | OperationResult<never>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    parser.on('error', (error) => {
      console.error('[transcribe] Invalid multipart body:', error);
      finish(pendingError ?? { status: 400, body: errorResponse('Invalid multipart form data') });
    });

    parser.on('close', () => {
      if (pendingError) {
        finish(pendingError);
        return;
      }

      if (audioFileCount === 0 || !audioContentType || audioSize === 0) {
        finish({ status: 400, body: errorResponse('Missing audio file') });
        return;
      }

      finish({
        body: Buffer.concat(audioChunks),
        contentType: audioContentType,
        requestSize,
      });
    });

    try {
      for await (const chunk of req) {
        const bufferChunk = chunk as Buffer;
        requestSize += bufferChunk.length;

        if (requestSize > MAX_REQUEST_SIZE) {
          aborted = true;
          setError({ status: 413, body: errorResponse('Request too large') });
          parser.destroy();
          break;
        }

        if (!parser.write(bufferChunk)) {
          await once(parser, 'drain');
        }
      }

      if (!aborted) {
        parser.end();
      }
    } catch (error) {
      console.error('[transcribe] Invalid multipart body:', error);
      finish({ status: 400, body: errorResponse('Invalid multipart form data') });
    }
  });
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

  const requestContentType = getMultipartContentType(req);
  if (!requestContentType) {
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

  const audioUpload = await parseMultipartAudioUpload(req, requestContentType.contentType);
  if ('status' in audioUpload) return audioUpload;

  console.log('[transcribe] Request received', {
    contentLength: audioUpload.requestSize,
    requestContentType: requestContentType.contentType,
    audioContentType: audioUpload.contentType,
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
        'Content-Type': audioUpload.contentType,
      },
      body: new Uint8Array(audioUpload.body),
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
