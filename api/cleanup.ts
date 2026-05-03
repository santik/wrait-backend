import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CallCountType } from '@prisma/client';
import { json } from '../src/lib/response.js';
import { prisma } from '../src/lib/prisma.js';
import { getUTCDayBucket, incrementCallCount } from '../src/lib/callCount.js';
import { ALLOWED_LANGUAGES } from '../src/lib/allowedLanguages.js';

export const config = { api: { bodyParser: false } };

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB
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
- Summarise or shorten the content
- Make the writing sound more formal or polished

If you are unsure whether a change is permitted, do not make it.
When in doubt, output the word exactly as it appears in the transcript.

Return only the cleaned text. No preamble, no explanation, no quotes.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);

  if (req.headers['x-proxy-secret'] !== process.env.PROXY_SECRET)
    return json(res, { error: 'Unauthorized' }, 401);

  const deviceId = req.headers['x-device-id'];
  if (!deviceId || typeof deviceId !== 'string' || !/^[a-fA-F0-9]{64}$/.test(deviceId)) {
    return json(res, { error: 'Invalid device ID' }, 400);
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(res, { error: 'Configuration error' }, 500);
  }

  const contentType = (req.headers['content-type'] as string | undefined) ?? '';
  if (!contentType.startsWith('application/json')) {
    return json(res, { error: 'Invalid Content-Type' }, 400);
  }

  let totalSize = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).byteLength;
    if (totalSize > MAX_BODY_SIZE) {
      return json(res, { error: 'Request too large' }, 413);
    }
    chunks.push(Buffer.from(chunk as Buffer));
  }

  let body: { transcript?: unknown; language?: unknown };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as typeof body;
  } catch {
    return json(res, { error: 'Invalid JSON body' }, 400);
  }

  if (!body.transcript || typeof body.transcript !== 'string' || body.transcript.trim().length < TRANSCRIPT_MIN_LENGTH) {
    return json(res, { error: 'Missing or invalid transcript' }, 400);
  }
  if (!body.language || typeof body.language !== 'string' || !ALLOWED_LANGUAGES.has(body.language)) {
    return json(res, { error: 'Missing or invalid language' }, 400);
  }
  const transcript = body.transcript as string;
  const language = body.language as string;

  try {
    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { deviceId: true },
    });
    if (!device) {
      await prisma.device.upsert({
        where: { deviceId },
        update: {},
        create: { deviceId },
      });
      console.log('[cleanup] Auto-registered device from cleanup endpoint', { deviceId });
    }
  } catch (error) {
    console.error('[cleanup] Failed to validate device:', {
      error: error instanceof Error ? error.message : String(error),
      deviceId,
    });
    return json(res, { error: 'Internal server error' }, 500);
  }

  console.log('[cleanup] Request received', {
    transcriptLength: transcript.length,
    language,
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
          { role: 'system', content: buildSystemPrompt(language) },
          { role: 'user', content: transcript.slice(0, TRANSCRIPT_MAX_LENGTH) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    console.error('[cleanup] Fetch error:', error);
    if (error instanceof Error && error.name === 'AbortError') {
      return json(res, { error: 'OpenAI request timeout' }, 504);
    }
    return json(res, { error: 'upstream_error' }, 502);
  } finally {
    clearTimeout(timeout);
  }

  if (!oaiRes.ok) {
    console.error('[cleanup] OpenAI error:', { status: oaiRes.status });
    return json(res, { error: 'upstream_error' }, 502);
  }

  let payload: unknown;
  try {
    payload = await oaiRes.json();
  } catch {
    console.error('[cleanup] Invalid JSON from OpenAI');
    return json(res, { error: 'upstream_error' }, 502);
  }

  const cleanedText = (payload as { choices?: Array<{ message?: { content?: string } }> })
    ?.choices?.[0]?.message?.content;

  if (!cleanedText || typeof cleanedText !== 'string') {
    console.error('[cleanup] Unexpected OpenAI response shape');
    return json(res, { error: 'upstream_error' }, 502);
  }

  await incrementCallCount(deviceId, getUTCDayBucket(), CallCountType.CLEANUP, 'cleanup');

  const wasTruncated = transcript.length > TRANSCRIPT_MAX_LENGTH;
  return json(res, { cleanedText, wasTruncated });
}
