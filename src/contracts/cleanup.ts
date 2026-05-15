import type { VercelRequest } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { ALLOWED_LANGUAGES } from '../lib/allowedLanguages.js';
import { getUTCDayBucket, incrementCallCount } from '../lib/callCount.js';
import { ensureDevice } from '../lib/device.js';
import {
  errorResponse,
  readRequestBody,
  requireDeviceId,
  requirePostMethod,
  requireProxySecret,
} from './http.js';
import type { OperationResult } from './http.js';
import type { CleanupRequestBody, CleanupResponseBody } from './openapi.js';

const MAX_BODY_SIZE = 1 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 25000;
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_TEMPERATURE = 0.3;
const OPENAI_MAX_TOKENS = 1024;
const TRANSCRIPT_MIN_LENGTH = 10;
const TRANSCRIPT_MAX_LENGTH = 3000;

function buildSystemPrompt(language: string): string {
  return `You are a transcription editor for a personal voice diary app.
The speaker's primary language is ${language}. They may also use words or phrases from other languages mid-sentence — this is intentional and must be preserved exactly as spoken.

You have received the raw speech-to-text transcript. Do exactly the following, nothing more:

REMOVE:
- Filler sounds and words (um, uh, er, and their equivalents in ${language})
- Mild redundancy: "I mean", "like", "you know", "basically", and equivalents in ${language}
- Exact word repetitions caused by hesitation (e.g. "I was I was going")

FIX:
- Punctuation and capitalisation
- Sentence boundaries so each sentence ends with proper punctuation
- Speech recognition errors — use the surrounding sentence as context to identify the intended word.
  Two types to correct:
  · A word that sounds like the intended word but is spelled differently ("their" → "there", "weer" → "weet")
  · A word that is completely out of place and breaks the meaning of the sentence
  Only make the correction if you are confident. If unsure, keep the word exactly as it appears in the transcript.

STRUCTURE:
- Add a paragraph break when the speaker clearly shifts to a different topic or moment

NEVER — these are absolute rules, not guidelines:
- Guess at a word correction when you are not confident — keep the original instead
- Add any word, name, place, number, or detail that does not appear in the transcript
- Rewrite or rephrase any sentence — change nothing except what is listed above
- Complete or extend an unfinished sentence — if it trails off, let it trail off
- Infer what the speaker meant and write that instead — only what was literally said
- Change the speaker's word choices or vocabulary
- Translate any word or phrase into another language — mixed-language speech must stay mixed
- Add anything the speaker did not say
- Summarise or shorten the content
- Make the writing sound more formal or polished

If you are unsure whether a change is permitted, do not make it.
When in doubt, output the word exactly as it appears in the transcript.

Return only the cleaned text. No preamble, no explanation, no quotes.`;
}

function isCleanupRequestBody(body: unknown): body is CleanupRequestBody {
  if (!body || typeof body !== 'object') return false;

  const transcript = (body as { transcript?: unknown }).transcript;
  const language = (body as { language?: unknown }).language;

  return (
    typeof transcript === 'string' &&
    transcript.trim().length >= TRANSCRIPT_MIN_LENGTH &&
    typeof language === 'string' &&
    ALLOWED_LANGUAGES.has(language)
  );
}

export async function handleCleanup(
  req: VercelRequest,
): Promise<OperationResult<CleanupResponseBody>> {
  const methodError = requirePostMethod(req);
  if (methodError) return methodError;

  const authError = requireProxySecret(req);
  if (authError) return authError;

  const device = requireDeviceId(req);
  if ('status' in device) return device;

  if (!process.env.OPENAI_API_KEY) {
    return { status: 500, body: errorResponse('Configuration error') };
  }

  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.startsWith('application/json')) {
    return { status: 400, body: errorResponse('Invalid Content-Type') };
  }

  const requestBody = await readRequestBody(req, MAX_BODY_SIZE);
  if ('status' in requestBody) return requestBody;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(requestBody.body.toString('utf-8')) as unknown;
  } catch {
    return { status: 400, body: errorResponse('Invalid JSON body') };
  }

  if (!isCleanupRequestBody(parsedBody)) {
    const transcript = (parsedBody as { transcript?: unknown }).transcript;
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length < TRANSCRIPT_MIN_LENGTH) {
      return { status: 400, body: errorResponse('Missing or invalid transcript') };
    }

    return { status: 400, body: errorResponse('Missing or invalid language') };
  }

  try {
    await ensureDevice(device.deviceId, 'cleanup');
  } catch (error) {
    console.error('[cleanup] Failed to validate device:', {
      error: error instanceof Error ? error.message : String(error),
      deviceId: device.deviceId,
    });
    return { status: 500, body: errorResponse('Internal server error') };
  }

  console.log('[cleanup] Request received', {
    transcriptLength: parsedBody.transcript.length,
    language: parsedBody.language,
    hasSecret: !!req.headers['x-proxy-secret'],
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let oaiRes: Response;
  try {
    oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: OPENAI_TEMPERATURE,
        max_tokens: OPENAI_MAX_TOKENS,
        messages: [
          { role: 'system', content: buildSystemPrompt(parsedBody.language) },
          { role: 'user', content: parsedBody.transcript.slice(0, TRANSCRIPT_MAX_LENGTH) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error('[cleanup] Fetch error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 504, body: errorResponse('OpenAI request timeout') };
    }
    return { status: 502, body: errorResponse('upstream_error') };
  } finally {
    clearTimeout(timeout);
  }

  if (!oaiRes.ok) {
    console.error('[cleanup] OpenAI error:', { status: oaiRes.status });
    return { status: 502, body: errorResponse('upstream_error') };
  }

  let payload: unknown;
  try {
    payload = await oaiRes.json();
  } catch {
    console.error('[cleanup] Invalid JSON from OpenAI');
    return { status: 502, body: errorResponse('upstream_error') };
  }

  const cleanedText = (payload as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;

  if (!cleanedText || typeof cleanedText !== 'string') {
    console.error('[cleanup] Unexpected OpenAI response shape');
    return { status: 502, body: errorResponse('upstream_error') };
  }

  await incrementCallCount(device.deviceId, getUTCDayBucket(), CallCountType.CLEANUP, 'cleanup');

  return {
    status: 200,
    body: {
      cleanedText,
      wasTruncated: parsedBody.transcript.length > TRANSCRIPT_MAX_LENGTH,
    },
  };
}
