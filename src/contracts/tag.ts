import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { getUTCDayBucket, incrementCallCount } from '../lib/callCount.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { buildIncrementedQuota, type RecordQuota, verifyDailyRecordQuota } from '../lib/quota.js';
import {
  ensureDeviceOrError,
  errorResponse,
  readJsonBody,
  readUpstreamJson,
  requireQuotaDeviceId,
  requirePostMethod,
  requireProxySecret,
} from './http.js';
import type { OperationResult } from './http.js';
import type { TagErrorResponse, TagResponseBody } from './openapi.js';

const MAX_BODY_SIZE = 256 * 1024;
const TYPESAFE_TIMEOUT_MS = 15000;
const TYPESAFE_MODEL = 'jev-latest';
const TEXT_MAX_UTF8_BYTES = 10000;
const TAGS_MIN = 2;
const TAGS_MAX = 50;
const TAG_MAX_LENGTH = 100;
const KNOWN_FIELDS = new Set(['text', 'tags']);

type TagRequestBody = {
  text: string;
  tags: string[];
};

type TagSuccessBody = TagResponseBody & {
  quota?: RecordQuota;
};

function validateTagRequestBody(
  body: unknown,
): { valid: true; parsed: TagRequestBody } | { valid: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Invalid request body' };
  }

  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) {
      return { valid: false, error: `Unknown field: ${key}` };
    }
  }

  if (typeof obj.text !== 'string' || obj.text.trim().length === 0) {
    return { valid: false, error: 'Missing or empty text' };
  }

  if (Buffer.byteLength(obj.text, 'utf8') > TEXT_MAX_UTF8_BYTES) {
    return { valid: false, error: `Text exceeds maximum length of ${TEXT_MAX_UTF8_BYTES} UTF-8 bytes` };
  }

  if (!Array.isArray(obj.tags)) {
    return { valid: false, error: 'Missing or invalid tags' };
  }

  if (obj.tags.length < TAGS_MIN) {
    return { valid: false, error: `At least ${TAGS_MIN} tags required` };
  }

  if (obj.tags.length > TAGS_MAX) {
    return { valid: false, error: `At most ${TAGS_MAX} tags allowed` };
  }

  for (const tag of obj.tags) {
    if (typeof tag !== 'string' || tag.length === 0) {
      return { valid: false, error: 'Each tag must be a non-empty string' };
    }
    if (tag.length > TAG_MAX_LENGTH) {
      return { valid: false, error: `Tag exceeds maximum length of ${TAG_MAX_LENGTH} characters` };
    }
  }

  const uniqueTags = new Set(obj.tags);
  if (uniqueTags.size !== obj.tags.length) {
    return { valid: false, error: 'Duplicate tags are not allowed' };
  }

  return { valid: true, parsed: { text: obj.text, tags: obj.tags } };
}

export async function handleTag(
  req: VercelRequest,
): Promise<OperationResult<TagSuccessBody, TagErrorResponse>> {
  const methodError = requirePostMethod(req);
  if (methodError) return methodError;

  const authError = requireProxySecret(req);
  if (authError) return authError;

  const device = requireQuotaDeviceId(req);
  if ('status' in device) return device;

  if (!process.env.TYPESAFE_API_KEY) {
    return { status: 500, body: errorResponse('Configuration error') };
  }

  const parsed = await readJsonBody(req, MAX_BODY_SIZE);
  if ('status' in parsed) return parsed;

  const validation = validateTagRequestBody(parsed.value);
  if (!validation.valid) {
    return { status: 400, body: errorResponse(validation.error) };
  }

  const { text, tags } = validation.parsed;

  const ensuredDevice = await ensureDeviceOrError(device.deviceId, 'tag');
  if ('status' in ensuredDevice) return ensuredDevice;

  const dayBucket = getUTCDayBucket();
  const quotaCheck = await verifyDailyRecordQuota(
    ensuredDevice.deviceId,
    ensuredDevice.dailyRecordLimit,
    CallCountType.TAG,
    'tag',
    dayBucket,
  );
  if (!quotaCheck.allowed) {
    return { status: quotaCheck.status, body: quotaCheck.body };
  }

  console.log('[tag] Request received', {
    textLength: text.length,
    tagCount: tags.length,
  });

  const questions: Record<string, { type: string; instructions: string }> = {};
  for (const tag of tags) {
    questions[tag] = {
      type: 'noul',
      instructions: `Does the tag '${tag}' apply to this text?`,
    };
  }

  let typesafeRes: Response;
  try {
    typesafeRes = await fetchWithTimeout(
      'https://api.typesafe.ai/v1/systemone',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: text,
          model: TYPESAFE_MODEL,
          questions,
        }),
      },
      TYPESAFE_TIMEOUT_MS,
    );
  } catch (error) {
    console.error('[tag] TypeSafe fetch error:', {
      error: error instanceof Error ? error.message : String(error),
      deviceId: ensuredDevice.deviceId,
    });
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 504, body: errorResponse('TypeSafe request timeout') };
    }
    return { status: 502, body: errorResponse('upstream_error') };
  }

  const upstream = await readUpstreamJson(typesafeRes, 'tag', ensuredDevice.deviceId);
  if ('status' in upstream) return upstream;

  const answers = (upstream.payload as { answers?: Record<string, { noul?: number }> })?.answers;

  if (!answers || typeof answers !== 'object') {
    console.error('[tag] TypeSafe returned unexpected response shape:', {
      deviceId: ensuredDevice.deviceId,
    });
    return { status: 502, body: errorResponse('upstream_error') };
  }

  const tagProbabilities = tags
    .map((tag) => {
      const noul = answers[tag]?.noul;
      const probability = typeof noul === 'number' && noul >= 0 && noul <= 1 ? noul : 0;
      return { tag, probability };
    })
    .sort((a, b) => b.probability - a.probability);

  const didPersistQuotaUsage = await incrementCallCount(
    ensuredDevice.deviceId,
    dayBucket,
    CallCountType.TAG,
    'tag',
  );

  return {
    status: 200,
    body: {
      tags: tagProbabilities,
      ...(didPersistQuotaUsage ? { quota: buildIncrementedQuota(quotaCheck.quota, dayBucket) } : {}),
    },
  };
}
