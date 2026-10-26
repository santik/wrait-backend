# Application Description

wrait-backend is the cloud API behind the Wrait voice-first journaling app. It
proxies the app's paid upstream work (speech-to-text, language-model cleanup and
tagging) and enforces per-device daily quotas on that work.

## Product summary

The backend is a small, stateless HTTP API deployed as Vercel serverless
functions over a PostgreSQL (Neon) database accessed through Prisma. It exists
to do three things: authenticate that a request really comes from the Wrait app,
meter each device against a daily quota so paid upstream calls cannot be abused,
and forward the allowed work to the upstream providers.

## API surface

All routes live under `api/` and share a common request contract
(`src/contracts/http.ts`): every request must present the shared proxy secret in
`X-Proxy-Secret`, and quota-bearing requests carry a device credential.

- `POST /api/register` — establishes or verifies a device's quota-bearing
  credential (see "Device identity and abuse protection"). Returns the issued
  token (when one is issued) and the device's current quota.
- `POST /api/transcribe` — speech-to-text for a recorded clip. Quota-protected.
- `POST /api/cleanup` — language-model cleanup of a transcript. Quota-protected.
- `POST /api/tag` — language-model tag suggestions for an entry. Quota-protected.
- `GET /api/hello` — liveness/diagnostic endpoint.

## Quota model

Quota is per device, per UTC day, per call type. Each allowed quota-protected
call increments a `CallCount` row keyed by `(deviceId, date, type)` where `type`
is `TRANSCRIPTION`, `CLEANUP`, or `TAG`. A device's daily limit comes from its
`Device.dailyRecordLimit` (nullable, falling back to the service default). When a
device is over its limit the call is rejected with a quota response that carries
the current counts and reset time, which the app surfaces to the user.

## Device identity and abuse protection

Quota is only meaningful if the identity it is keyed on is trustworthy. The
backend issues each device a **signed device token** and keys quota on the
identity inside it rather than on a raw client-supplied identifier.

- **Token:** an HMAC-SHA256 signature over the device identifier, serialized as
  `base64url(deviceId).base64url(hmac)` and signed with `DEVICE_TOKEN_SECRET`.
  The app stores it and presents it as `X-Device-Token` on quota-protected
  calls. Tokens carry no expiry; rotating the secret invalidates all tokens and
  clients transparently re-register.
- **`/register` is dual-mode:** presented a valid token, it verifies and keeps
  it (and returns current quota); presented no token (or an unverifiable one),
  it issues a fresh token bound to the supplied `X-Device-Id`. Because the issue
  path is the only way to mint new quota-bearing identities, it is the abuse
  surface.
- **Registration rate limit:** token issuance is capped per client IP per UTC
  day (`RegistrationAttempt` table, `MAX_REGISTRATIONS_PER_IP_PER_DAY`, default
  10). Over the cap, `/register` returns HTTP 429 and the app surfaces a
  retriable state. This bounds casual and scripted quota resets; it does not try
  to defeat an attacker who controls many network origins (platform attestation
  is explicitly out of scope).
- **Migration window:** `REQUIRE_DEVICE_TOKEN` defaults to strict. Set to
  `false` during rollout so quota endpoints also accept a legacy `X-Device-Id`,
  letting existing clients keep working until they upgrade; the issued token is
  bound to that same device id so accrued quota carries over.

## Deployment

The service deploys to Vercel as serverless functions. Database schema changes
run as Prisma migrations during the Vercel install step (`npm install &&
prisma migrate deploy`), so a deploy both ships code and applies pending
migrations. The datasource uses `DATABASE_URL_UNPOOLED` when present, otherwise
`DATABASE_URL`. See `specs/004-quota-abuse-protection/deployment.md` for the
cross-repo rollout runbook (env, migration, and client/backend ordering).

## Client contract note

The Wrait app depends on this contract through a checked-in OpenAPI document
(`api/wrait-backend.yaml` in the app repo). Changes to request/response shapes,
headers, or status codes are contract changes that must stay in step with the
app's generated client. Header names and credential formats are implementation
details owned by this repo and recorded in `docs/agent-findings.md`.
