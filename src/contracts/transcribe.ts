import { once } from 'node:events';
import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import busboy from 'busboy';
import { getUTCDayBucket, incrementCallCount } from '../lib/callCount.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { loadCleanupQuotaSafe, type RecordQuota, verifyDailyRecordQuota } from '../lib/quota.js';
import {
  TRANSCRIPTION_LANGUAGES,
  type TranscriptionLanguage,
} from '../generated/transcriptionLanguages.js';
import {
  ensureDeviceOrError,
  errorResponse,
  getRequestUrl,
  requireQuotaDeviceId,
  requirePostMethod,
  requireProxySecret,
} from './http.js';
import type { OperationResult } from './http.js';
import type {
  TranscribeErrorResponse,
  TranscribeResponseBody,
  UpstreamErrorResponse,
} from './openapi.js';

type TranscribeSuccessBody = TranscribeResponseBody & {
  quota?: RecordQuota;
};

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
const TRANSCRIPTION_LANGUAGE_SET: ReadonlySet<string> = new Set(TRANSCRIPTION_LANGUAGES);

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

function getMultipartContentType(req: VercelRequest): string | null {
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

  return contentType;
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

  // A resolved Promise ignores later resolve() calls, so whichever of the
  // parser events or the feed loop finishes first wins — no manual settle guard
  // needed. The feed runs as a self-invoking async block so the executor itself
  // stays synchronous (no async-Promise-executor swallowing throws).
  return new Promise<MultipartAudioUpload | OperationResult<never>>((resolve) => {
    parser.on('error', (error) => {
      console.error('[transcribe] Invalid multipart body:', error);
      resolve(pendingError ?? { status: 400, body: errorResponse('Invalid multipart form data') });
    });

    parser.on('close', () => {
      if (pendingError) {
        resolve(pendingError);
        return;
      }

      if (audioFileCount === 0 || !audioContentType || audioSize === 0) {
        resolve({ status: 400, body: errorResponse('Missing audio file') });
        return;
      }

      resolve({
        body: Buffer.concat(audioChunks),
        contentType: audioContentType,
        requestSize,
      });
    });

    void (async () => {
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
        resolve({ status: 400, body: errorResponse('Invalid multipart form data') });
      }
    })();
  });
}

type RequestedLanguageResult =
  | { ok: true; value: TranscriptionLanguage | null }
  | { ok: false; error: OperationResult<never> };

function isTranscriptionLanguage(value: string): value is TranscriptionLanguage {
  return TRANSCRIPTION_LANGUAGE_SET.has(value);
}

function getRequestedLanguage(req: VercelRequest): RequestedLanguageResult {
  const languages = getRequestUrl(req).searchParams.getAll('language');
  if (languages.length === 0) return { ok: true, value: null };

  if (languages.length !== 1 || !isTranscriptionLanguage(languages[0])) {
    return {
      ok: false,
      error: { status: 400, body: errorResponse('Invalid language') },
    };
  }

  return { ok: true, value: languages[0] };
}

function buildDeepgramSearch(language: string | null): string {
  const searchParams = new URLSearchParams();

  for (const [name, value] of Object.entries(DEFAULT_TRANSCRIBE_QUERY)) {
    searchParams.set(name, String(value));
  }

  if (language) {
    searchParams.delete('detect_language');
    searchParams.set('language', language);
  }

  // DEFAULT_TRANSCRIBE_QUERY always contributes keys, so the query is never empty.
  return `?${searchParams.toString()}`;
}

function getDeepgramChannel(
  payload: unknown,
  requestedLanguage: string | null,
): { transcript: string; detectedLanguage: string } | null {
  if (!payload || typeof payload !== 'object') return null;

  const results = (payload as { results?: unknown }).results;
  if (!results || typeof results !== 'object') return null;

  const channels = (results as { channels?: unknown }).channels;
  if (!Array.isArray(channels) || channels.length === 0) return null;

  const firstChannel = channels[0] as { alternatives?: unknown; detected_language?: unknown };
  const alternatives = firstChannel.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  const transcript = (alternatives[0] as { transcript?: unknown }).transcript;
  const detectedLanguage = requestedLanguage ?? firstChannel.detected_language;

  if (typeof transcript !== 'string' || typeof detectedLanguage !== 'string') {
    return null;
  }

  return { transcript, detectedLanguage };
}

export async function handleTranscribe(
  req: VercelRequest,
): Promise<OperationResult<TranscribeSuccessBody, TranscribeErrorResponse>> {
  const methodError = requirePostMethod(req);
  if (methodError) return methodError;

  const authError = requireProxySecret(req);
  if (authError) return authError;

  const device = requireQuotaDeviceId(req);
  if ('status' in device) return device;

  const requestContentType = getMultipartContentType(req);
  if (!requestContentType) {
    console.error('[transcribe] Invalid Content-Type:', req.headers['content-type']);
    return { status: 400, body: errorResponse('Invalid Content-Type') };
  }

  const languageResult = getRequestedLanguage(req);
  if (!languageResult.ok) return languageResult.error;
  const requestedLanguage = languageResult.value;

  const ensuredDevice = await ensureDeviceOrError(device.deviceId, 'transcribe');
  if ('status' in ensuredDevice) return ensuredDevice;

  const dayBucket = getUTCDayBucket();
  const quotaCheck = await verifyDailyRecordQuota(
    ensuredDevice.deviceId,
    ensuredDevice.dailyRecordLimit,
    CallCountType.TRANSCRIPTION,
    'transcribe',
    dayBucket,
  );
  if (!quotaCheck.allowed) {
    return { status: quotaCheck.status, body: quotaCheck.body };
  }

  const audioUpload = await parseMultipartAudioUpload(req, requestContentType);
  if ('status' in audioUpload) return audioUpload;

  console.log('[transcribe] Request received', {
    contentLength: audioUpload.requestSize,
    requestContentType,
    audioContentType: audioUpload.contentType,
    hasSecret: !!req.headers['x-proxy-secret'],
  });

  const search = buildDeepgramSearch(requestedLanguage);

  console.log('[transcribe] Forwarding to Deepgram', { search });

  let dgRes: Response;
  try {
    dgRes = await fetchWithTimeout(
      `https://api.deepgram.com/v1/listen${search}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          'Content-Type': audioUpload.contentType,
        },
        body: new Uint8Array(audioUpload.body),
      },
      DEEPGRAM_TIMEOUT_MS,
    );
  } catch (error) {
    console.error('[transcribe] Fetch error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 504, body: errorResponse('Deepgram request timeout') };
    }
    return { status: 502, body: errorResponse('Failed to reach Deepgram') };
  }

  let payload: unknown;
  try {
    payload = await dgRes.json();
  } catch {
    console.error('[transcribe] Invalid JSON from Deepgram');
    return { status: 502, body: errorResponse('Invalid response from upstream') };
  }

  if (!dgRes.ok) {
    return { status: 502, body: payload as UpstreamErrorResponse };
  }

  const deepgramChannel = getDeepgramChannel(payload, requestedLanguage);
  if (!deepgramChannel) {
    console.error('[transcribe] Unexpected Deepgram response shape');
    return { status: 502, body: errorResponse('Invalid response from upstream') };
  }

  if (deepgramChannel.transcript.trim() === '') {
    console.warn('[transcribe] Empty transcript from Deepgram', {
      language: requestedLanguage ?? 'auto',
    });
    return {
      status: 422,
      body: {
        error: 'Speech could not be recognized',
        reason: 'speech_not_recognized',
        ...(requestedLanguage ? { language: requestedLanguage } : {}),
      },
    };
  }

  await incrementCallCount(ensuredDevice.deviceId, dayBucket, CallCountType.TRANSCRIPTION, 'transcribe');

  const cleanupQuota = await loadCleanupQuotaSafe(ensuredDevice, dayBucket, 'transcribe');

  return {
    status: 200,
    body: {
      transcript: deepgramChannel.transcript,
      detected_language: deepgramChannel.detectedLanguage,
      ...(cleanupQuota ? { quota: cleanupQuota } : {}),
    },
  };
}
