# wrait-backend

`wrait-backend` is a small TypeScript backend for the Wrait voice diary app. It runs as Vercel serverless functions, stores device metadata and usage counters in Postgres through Prisma, proxies speech-to-text requests to Deepgram, and cleans up transcripts with OpenAI.

## What It Does

- Registers client devices by hashed device ID.
- Accepts raw audio uploads and forwards them to Deepgram.
- Accepts raw transcripts and cleans them up for diary-quality text.
- Tracks successful transcription and cleanup calls per device, per UTC day.
- Protects all non-public routes with a shared proxy secret.

## Stack

- Runtime: Node.js 20+
- Language: TypeScript with ESM
- Hosting: Vercel serverless functions
- Database: PostgreSQL
- ORM: Prisma 7 with `@prisma/adapter-pg`
- Upstream APIs:
  - Deepgram for speech-to-text
  - OpenAI for transcript cleanup
- Tests: Vitest

## Project Structure

```text
api/
  hello.ts        Public health check
  register.ts     Device registration
  transcribe.ts   Audio proxy to Deepgram
  cleanup.ts      Transcript cleanup via OpenAI

src/lib/
  prisma.ts       Shared Prisma client
  response.ts     JSON response helper
  callCount.ts    Per-day usage counter helpers
  allowedLanguages.ts

prisma/
  schema.prisma   Database schema
  migrations/     SQL migrations

tests/
  *.test.ts       Route and helper coverage
```

## How Requests Flow

```mermaid
flowchart LR
  A["Wrait app"] --> B["Vercel API route"]
  B --> C["Header validation"]
  C --> D["Device lookup / auto-register"]
  D --> E["Deepgram or OpenAI"]
  D --> F["Postgres via Prisma"]
  E --> B
  B --> G["JSON response"]
  E --> H["Best-effort call counter"]
  H --> F
```

## Environment Variables

The codebase uses two database URLs for different purposes:

- `DATABASE_URL`: runtime connection used by `src/lib/prisma.ts`
- `DATABASE_URL_UNPOOLED`: Prisma CLI / config connection used by `prisma.config.ts`

### Required at Runtime

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `src/lib/prisma.ts` | Postgres connection string for API runtime |
| `NODE_ENV` | `src/lib/prisma.ts` | Enables Prisma client reuse outside production |
| `PROXY_SECRET` | `api/register.ts`, `api/transcribe.ts`, `api/cleanup.ts` | Shared secret required on protected routes |
| `DEEPGRAM_API_KEY` | `api/transcribe.ts` | Authenticates requests to Deepgram |
| `OPENAI_API_KEY` | `api/cleanup.ts` | Authenticates requests to OpenAI |

### Required for Prisma Commands

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL_UNPOOLED` | `prisma.config.ts` | Direct database URL for Prisma CLI |

### Example `.env`

```bash
DATABASE_URL=postgres://user:password@host:5432/dbname?sslmode=require
DATABASE_URL_UNPOOLED=postgres://user:password@direct-host:5432/dbname?sslmode=require
NODE_ENV=development
PROXY_SECRET=replace-with-a-long-random-secret
DEEPGRAM_API_KEY=dg_xxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxx
```

## Local Development

### 1. Install dependencies

```bash
npm install
```

`postinstall` runs `prisma generate`, so the Prisma client is generated automatically.

### 2. Apply database migrations

```bash
npx prisma migrate dev
```

### 3. Start the API locally

```bash
npx vercel dev
```

Vercel will expose the routes under `/api/*`.

## Useful Scripts

```bash
npm run type-check
npm run lint
npm run format
npm test
npm run test:watch
```

## API Overview

### Common Auth Headers

All protected routes require:

- `X-Proxy-Secret: <PROXY_SECRET>`
- `X-Device-Id: <64-character hex string>`

`X-Device-Id` must match `^[a-fA-F0-9]{64}$`.

### `GET /api/hello`

Public health check.

#### Response

```json
{
  "message": "Hello, World!"
}
```

### `POST /api/register`

Registers a device explicitly. If the device already exists, the endpoint behaves idempotently because it uses `upsert`.

#### Headers

```http
X-Proxy-Secret: <secret>
X-Device-Id: <64-char hex>
```

#### Success response

Status: `201 Created`

```json
{
  "ok": true
}
```

#### Error responses

- `401` if the proxy secret is wrong or missing
- `400` if the device ID is missing or invalid
- `405` for non-`POST` methods
- `500` if the database write fails

### `POST /api/transcribe`

Accepts raw audio, forwards it to Deepgram, and returns Deepgram's JSON response body.

#### Headers

```http
X-Proxy-Secret: <secret>
X-Device-Id: <64-char hex>
Content-Type: audio/mp4 | audio/m4a | audio/wav | audio/webm
```

#### Query parameters

The route forwards the incoming query string to Deepgram verbatim. Example parameters from tests:

- `model=nova-3`
- `punctuate=true`
- `smart_format=true`
- `language=en`
- `detect_language=true`

#### Constraints

- Max request size: `25 MB`
- Upstream timeout: `55 seconds`
- Body parser disabled so raw audio can be streamed
- Unknown devices are auto-registered before the upstream call

#### Success behavior

- Returns `200` with Deepgram's JSON payload
- Increments the `TRANSCRIPTION` call counter for the current UTC day

#### Error responses

- `401` unauthorized
- `400` invalid device ID or unsupported `Content-Type`
- `413` request too large
- `500` database failure while validating the device
- `502` Deepgram/network/invalid-upstream-response failure
- `504` Deepgram timeout

### `POST /api/cleanup`

Accepts a raw transcript and language, sends them to OpenAI, and returns a cleaned transcript.

#### Headers

```http
X-Proxy-Secret: <secret>
X-Device-Id: <64-char hex>
Content-Type: application/json
```

#### Body

```json
{
  "transcript": "um, like, you know, the meeting was, uh, really productive",
  "language": "en-US"
}
```

#### Input rules

- `transcript` must be a string with at least `10` non-empty characters
- `transcript` is truncated to `3000` characters before it is sent to OpenAI
- `language` must be in the allowlist from `src/lib/allowedLanguages.ts`
- Max body size: `1 MB`

#### OpenAI request settings

- Model: `gpt-4o-mini`
- Temperature: `0.3`
- Max output tokens: `1024`
- Timeout: `25 seconds`

#### Response

```json
{
  "cleanedText": "The meeting was really productive.",
  "wasTruncated": false
}
```

#### Success behavior

- Returns only cleaned text, not the full OpenAI response
- Auto-registers unknown devices
- Increments the `CLEANUP` call counter for the current UTC day

#### Error responses

- `401` unauthorized
- `400` invalid content type, JSON, transcript, or language
- `413` request too large
- `500` missing `OPENAI_API_KEY` or device validation failure
- `502` upstream error / invalid upstream response
- `504` OpenAI timeout

## Supported Cleanup Languages

Cleanup accepts a curated BCP-47 allowlist, including:

- English
- Dutch
- German
- French
- Spanish
- Italian
- Portuguese
- Japanese
- Chinese
- Korean
- Russian
- Polish
- Turkish
- Swedish
- Danish
- Finnish
- Norwegian
- Arabic
- Hindi
- Indonesian
- Malay
- Thai
- Ukrainian
- Czech
- Slovak
- Romanian
- Hungarian
- Bulgarian
- Croatian
- Greek
- Hebrew
- Vietnamese
- Catalan

See [src/lib/allowedLanguages.ts](src/lib/allowedLanguages.ts) for the exact locale codes.

## Database Schema

The database has two tables and one enum:

### `devices`

Tracks known client devices.

| Column | Type | Notes |
| --- | --- | --- |
| `device_id` | `String` | Primary key |
| `registered_at` | `DateTime` | Defaults to `now()` |

### `call_counts`

Tracks successful API usage by device, day, and operation type.

| Column | Type | Notes |
| --- | --- | --- |
| `device_id` | `String` | Device identifier |
| `date` | `Date` | UTC day bucket |
| `type` | `CallCountType` | `TRANSCRIPTION` or `CLEANUP` |
| `count` | `Int` | Defaults to `1` |

Unique key: `(device_id, date, type)`

### `CallCountType`

- `TRANSCRIPTION`
- `CLEANUP`

## Call Counting

Successful transcription and cleanup requests increment a per-day counter using raw SQL with `INSERT ... ON CONFLICT DO UPDATE`.

Behavior worth knowing:

- Counting is best-effort: failures are logged but do not fail the API response.
- Transient database errors are retried with delays of `0ms`, `25ms`, and `75ms`.
- Counters are bucketed to UTC midnight using `getUTCDayBucket()`.

## Deployment Notes

The repository is configured for Vercel.

- Region: `cdg1`
- Default function max duration: `10s`
- `/api/transcribe.ts` max duration: `60s`
- Global security headers are set in `vercel.json`, including:
  - `Strict-Transport-Security`
  - `X-Content-Type-Options`
  - `X-Frame-Options`
  - `Referrer-Policy`
  - `Permissions-Policy`
  - `Content-Security-Policy: default-src 'none'`

## Testing

Test coverage focuses on route behavior and counter logic:

- `tests/hello.test.ts`
- `tests/register.test.ts`
- `tests/transcribe.test.ts`
- `tests/cleanup.test.ts`
- `tests/callCount.test.ts`

Coverage includes:

- method validation
- auth and device ID validation
- request size limits
- content-type validation
- upstream success and failure handling
- auto-registration of unknown devices
- counter retries and UTC day bucketing

Run the full suite with:

```bash
npm test
```

## Example Requests

Examples are also available in [vercel-api.http](vercel-api.http).

### Hello

```bash
curl https://your-deployment.vercel.app/api/hello
```

### Register

```bash
curl -X POST https://your-deployment.vercel.app/api/register \
  -H "X-Proxy-Secret: $PROXY_SECRET" \
  -H "X-Device-Id: $DEVICE_ID"
```

### Transcribe

```bash
curl -X POST "https://your-deployment.vercel.app/api/transcribe?model=nova-3&punctuate=true&smart_format=true&language=en&detect_language=true" \
  -H "X-Proxy-Secret: $PROXY_SECRET" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: audio/wav" \
  --data-binary @tests/audio.wav
```

### Cleanup

```bash
curl -X POST https://your-deployment.vercel.app/api/cleanup \
  -H "X-Proxy-Secret: $PROXY_SECRET" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "um, like, you know, the meeting was, uh, really productive, right?",
    "language": "en"
  }'
```

## Known Implementation Notes

- `GET /api/hello` is public; all other routes require the proxy secret.
- `register` requires explicit registration, but `transcribe` and `cleanup` also auto-register missing devices.
- `transcribe` returns the upstream Deepgram body directly on success and on non-OK upstream responses.
- `cleanup` returns a backend-shaped response with `cleanedText` and `wasTruncated`.
- The shared `json()` helper always sets `Cache-Control`, defaulting to `no-store`.