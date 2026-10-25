# Feature Specification: Quota Abuse Protection

> **Feature number:** 004
> **Status:** Approved
> **Author:** santik.alex@gmail.com
> **Date:** 2026-10-21
> **Work item:** n/a

## Status history

| Date       | Status | Author                 | Notes                                                       |
| ---------- | ------ | ---------------------- | ----------------------------------------------------------- |
| 2026-10-21 | Draft  | santik.alex@gmail.com  | Initial spec created                                        |
| 2026-10-21 | Draft  | santik.alex@gmail.com  | Clarified: `/register` dual mode, launch quota, migration   |
| 2026-10-21 | Approved | santik.alex@gmail.com | Clarify complete; approved for planning                     |

---

## Overview

The backend enforces per-device daily quotas on paid upstream calls
(transcription, cleanup, tagging). Today that quota is keyed on an identifier
the caller supplies in the request and that the server accepts without
verification: any value in the expected format is upserted into a fresh device
record with its own untouched quota. As a result a caller can obtain unlimited
quota simply by presenting a new identifier, and a caller who extracts the
single shared access secret shipped with the app can do so from outside the app
entirely. Before opening the service to a wider audience this allows unbounded
abuse of paid upstream services (speech-to-text and language-model calls).

This feature makes the identity that quota is keyed on **trustworthy** and
**limits the rate at which new quota-bearing identities can be created**, so
that casual and scripted abuse can no longer reset or multiply quota. It does
not attempt to defeat a determined attacker who controls many network origins;
that stronger guarantee (platform attestation) is explicitly out of scope and
recorded below.

> **Reminder:** This spec is purely functional and technology-agnostic.
> Credential formats, signing schemes, storage tables, and header names are
> implementation choices and belong in `plan.md`.

## User stories

- As the service owner, I want quota to be keyed on an identity the client
  cannot forge, so that a caller cannot reset their quota by changing a value in
  the request.
- As the service owner, I want the creation of new quota-bearing identities to
  be rate-limited, so that a caller cannot cheaply mint unlimited fresh quota.
- As the service owner, I want a leaked access secret to no longer grant
  unlimited quota, so that the blast radius of any single leak is contained to
  one identity's quota.
- As a legitimate app user, I want this protection to be invisible, so that my
  normal usage is never blocked, slowed, or interrupted.

## Acceptance criteria

- [ ] A request to a quota-protected endpoint whose quota identity was **not
      previously issued by the server** is rejected, rather than silently
      granted fresh quota.
- [ ] Changing the quota-identity value in a request to an arbitrary
      well-formed value does **not** yield additional quota.
- [ ] The number of new quota-bearing identities that can be obtained from a
      single network origin within a defined time window is capped; requests
      beyond the cap are refused with a distinct, retriable error.
- [ ] There is **no** path to create a quota-bearing identity that bypasses the
      registration rate limit.
- [ ] A legitimate first-time caller can obtain a quota identity and
      immediately use every quota-protected endpoint.
- [ ] `/register` returns the current quota snapshot in both Mode A and Mode B,
      so the client can display quota at app start with no contract change.
- [ ] A returning client presenting a valid credential (Mode B) is never
      refused by the registration rate limit, regardless of launch frequency.
- [ ] An existing installed client is migrated by binding a newly issued
      credential to its existing identifier, so its previously accrued quota
      carries over and is not reset.
- [ ] All new rejection responses are structured and leak no implementation
      details or secrets.
- [ ] The existing per-device daily quota accounting continues to work
      unchanged for a verified identity.

## API contract

> Concrete header names, credential encoding, and field names are deferred to
> `plan.md`. This section states the contract in functional terms.

### Registration endpoint (modified)

`/register` remains the single call the client makes at launch, and it still
returns the current **quota snapshot** in its success body (unchanged field),
so the app can display quota at startup exactly as today. It now operates in two
modes, selected by whether the caller already holds a server-issued credential:

- **Mode A — no credential presented** (first install, or first launch after
  upgrading from a build that had no credential): the server **issues a new
  credential** and returns it alongside the quota snapshot. This is the only
  path that creates a new quota-bearing identity, and it is the path subject to
  the **per-origin registration rate limit**. On a post-upgrade launch the
  issued credential is **bound to the device's existing identifier** so that
  the user's already-accrued quota carries over rather than resetting.
- **Mode B — valid credential presented** (every normal launch thereafter): the
  server **verifies** the credential and returns that identity's current quota
  snapshot. No new identity is created, so **Mode B is not rate-limited** — a
  returning app may launch as often as it likes without consuming the per-origin
  cap.

A credential that is present but malformed or unverifiable is **ignored** and
the request is handled as Mode A; it is not a hard error. Because the client
always includes its device identifier on `/register`, a single call self-heals
from an expired or rotated credential without a second round trip.

**Error responses:**

| Status | Body                  | When                                             |
| ------ | --------------------- | ------------------------------------------------ |
| 401    | `{ "error": "..." }`  | First-line access secret missing/invalid         |
| 400    | `{ "error": "..." }`  | Mode A: device identifier missing or malformed (including when a presented credential is invalid and no valid identifier accompanies it) |
| 429    | `{ "error": "..." }`  | Per-origin registration rate limit exceeded (Mode A) |
| 500    | `{ "error": "..." }`  | Internal error                                   |

### Quota-protected endpoints (modified): transcribe, cleanup, tag

**Behavior change:** each requires a valid server-issued credential. Quota is
keyed on the identity carried by that credential, not on a caller-supplied
value.

**Error responses:**

| Status | Body                  | When                                             |
| ------ | --------------------- | ------------------------------------------------ |
| 401    | `{ "error": "..." }`  | Access secret missing/invalid                    |
| 403    | `{ "error": "..." }`  | Credential missing, malformed, or not verifiable |
| 429    | `{ "error": "..." }`  | Daily quota exceeded (existing behavior retained) |

## Data model changes

- A persistent record of **issued identities** sufficient for the server to
  verify a presented credential belongs to an identity it issued. (The existing
  device record may be extended, or a new record introduced — decided in
  `plan.md`.)
- A persistent, time-bucketed **counter of registration attempts per network
  origin**, analogous to the existing per-device call counter, to enforce the
  registration rate limit across stateless invocations.
- Migration impact on existing device records is an open question (below).

## Dependencies

- [ ] Existing per-device quota accounting (`CallCount`) — reused unchanged.
- [ ] Existing persistent datastore (Prisma/Postgres) for the new records.
- [ ] Existing first-line access secret — retained, retired, or rotated per an
      open question below.
- [ ] Client counterpart feature (Flutter `059-quota-abuse-protection`) must
      consume the updated contract; the backend contract lands first.

## UX / design references

Not applicable — backend only. User-facing behavior is specified in the Flutter
feature spec.

## Non-functional requirements

- **Performance:** credential verification must add negligible latency to each
  request and must not introduce an additional network round trip.
- **Security:** the quota identity must be unforgeable by any client; any secret
  used to issue or verify credentials must never leave the server; Mode A
  registration must be rate-limited to ~10 per IP per 24h, configurable
  (Constitution §5); the existing shared access secret is retained as a
  first-line filter. Credentials are long-lived (no expiry). No secret or stack
  trace may appear in responses or logs.
- **Reliability:** legitimate clients must never be locked out by this feature;
  rate-limit and credential errors must be structured and, where appropriate,
  retriable.
- **Scalability:** the rate-limit and verification mechanisms must work under
  the stateless, per-invocation execution model (no reliance on in-process
  memory between requests).
- **Observability:** registration-rate-limit refusals and credential
  verification failures must be logged (counts/reasons), without logging secrets
  or credential contents.

## Out of scope

- Platform attestation (Play Integrity / App Attest) or any mechanism that tries
  to prove the request originates from a genuine, unmodified app. This feature
  deliberately does not stop an attacker who rotates across many network
  origins.
- User accounts, email/password, or any personally identifiable identity.
- Changing quota limits or quota values themselves.
- Certificate pinning and transport-layer hardening.

## Resolved clarifications

- **`/register` role:** retained as the single launch handshake, operating in
  two modes (A: issue credential, rate-limited; B: verify credential, not
  rate-limited). See the API contract section.
- **App-start quota display:** `/register` continues to return the quota
  snapshot in its success body in both modes; no change to how the client
  obtains quota at startup.
- **Migration:** existing installed devices are **not** forced through a
  disruptive flow — on first post-upgrade launch the server issues a credential
  **bound to the device's existing identifier**, carrying over accrued quota.
- **Rate-limit value:** the per-origin cap on Mode A registrations is **~10 per
  IP per 24-hour window**, configurable via environment. Returning clients
  (Mode B) are never counted against it. Accepted residual risk: users sharing a
  single origin at high volume (carrier-grade NAT, large offices) could in rare
  cases hit the cap on simultaneous fresh installs.
- **Credential lifetime:** credentials are **long-lived with no expiry**. The
  quota-only threat model makes the worst case of a leaked credential the
  sharing of a single identity's quota, so expiry/renewal complexity is not
  justified (Constitution §2).
- **Access secret disposition:** the existing shared access secret is **kept as
  a first-line filter** in front of the credential logic (and may be rotated on
  release); it is not retired.

## Open questions

None remaining — all clarifications resolved above. Ready for planning on
approval.
