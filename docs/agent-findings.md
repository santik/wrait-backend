# Agent Findings

This file is the compact, active guidance index for future coding sessions.
Keep it focused on durable implementation constraints that should affect new
work.

When a detail here conflicts with `AGENTS.md`, `CLAUDE.md`, the `.codesight`
wiki, or an approved story artifact, treat the formal workflow artifact as the
gate and use this file as supporting implementation memory. The `.codesight`
wiki is AST-generated — regenerate it (`npx codesight --wiki`) after structural
changes (new routes, models, or env vars) rather than hand-editing it.

## HTTP contract and proxy auth

- Every route goes through the shared request contract in
  `src/contracts/http.ts`. Do not re-implement header parsing or auth per route.
- `X-Proxy-Secret` must match `PROXY_SECRET` on every request, including
  `/register`. A missing or wrong secret is rejected before any quota or upstream
  work.
- Responses are built through `src/lib/response.ts`; keep new endpoints on that
  helper so status/shape stays consistent with the OpenAPI contract the app
  generates its client from.

## Device identity and tokens

- Quota is keyed on the identity inside a **signed device token**, not on a raw
  client-supplied id. Token logic lives in `src/lib/deviceToken.ts`:
  HMAC-SHA256 over the device id, serialized `base64url(deviceId).base64url(hmac)`,
  signed with `DEVICE_TOKEN_SECRET`.
- `DEVICE_TOKEN_SECRET` is required and long-lived. Rotating it invalidates all
  issued tokens; clients recover by re-registering on the next rejected call, so
  rotation is safe but forces a re-register wave.
- Tokens carry no `iat`/expiry by design (kept minimal). Do not add fields to the
  token without a contract change — the app parses this exact format.
- The token value is a secret: never log it or include it in error payloads or
  diagnostics.
- `src/lib/deviceId.ts` normalizes/validates device identifiers; reuse it rather
  than trusting raw header values.

## Registration dual-mode and rate limit

- `/register` (`src/contracts/register.ts`) is dual-mode: a valid presented token
  is verified and kept; otherwise a fresh token is issued and bound to the
  supplied `X-Device-Id`. A single call is always sufficient for the client.
- Token **issuance** is rate-limited per client IP per UTC day via the
  `RegistrationAttempt` table and `src/lib/registrationLimit.ts`
  (`MAX_REGISTRATIONS_PER_IP_PER_DAY`, default 10). Verification of an existing
  token is not rate-limited.
- The retention prune (delete attempts older than the cutoff) is gated to run
  only occasionally (when a counter is at 1), not on every request — keep that
  guard to avoid a delete on the hot path.

## Quota and call counting

- Quota is per `(deviceId, date, type)` in `CallCount` (`src/lib/callCount.ts`,
  `src/lib/quota.ts`), where `type` is `TRANSCRIPTION`, `CLEANUP`, or `TAG`.
- `Device.dailyRecordLimit` is nullable; fall back to the service default when
  unset. Quota responses must carry the counts and reset time the app displays.
- `REQUIRE_DEVICE_TOKEN` (default strict) governs the migration window. When
  `false`, quota endpoints also accept a legacy `X-Device-Id`; the contract
  helper (`isDeviceTokenRequired`) owns that decision — do not branch on the env
  var inside individual routes.

## Database, Prisma, and resilience

- Models: `Device`, `CallCount`, `RegistrationAttempt` (see
  `prisma/schema.prisma`). Table names are snake_case via `@@map`.
- The datasource reads `DATABASE_URL_UNPOOLED` when present, else `DATABASE_URL`
  — Prisma needs an unpooled connection for migrations and reliable serverless
  use.
- Wrap transient database work with `src/lib/dbRetry.ts`; do not add ad-hoc retry
  loops in routes.
- Schema changes ship as Prisma migrations and are applied by the Vercel install
  step (`prisma migrate deploy`). Combine related schema changes into one
  migration where possible; a migration must be present in a deploy for the code
  depending on it to work.

## Upstream calls

- Upstream providers are reached with `src/lib/fetchWithTimeout.ts`; keep a
  bounded timeout on every upstream call so a slow provider can't hang a
  serverless invocation.
- Upstream API keys (`DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`)
  are server-only secrets; never echo them to clients or logs.

## Deployment and rollout gotchas

- A missing `DEVICE_TOKEN_SECRET` fails requests at runtime; set it in the Vercel
  environment before shipping the strict path.
- Changing an env var in Vercel requires a redeploy to take effect (a saved value
  alone does not apply to running functions).
- The Vercel install-command override must include `prisma migrate deploy`, or
  migrations never run and token/registration tables are missing in production.
- Full rollout ordering (ship backend with `REQUIRE_DEVICE_TOKEN=false`, release
  the client, then flip to strict) is recorded in
  `specs/004-quota-abuse-protection/deployment.md`.
