# Feature Specification: Tag Probability

> **Feature number:** 003
> **Status:** Draft
> **Author:** Alexander Fedorets
> **Date:** 2026-10-18
> **Work item:** Not assigned

## Status history

| Date       | Status | Author             | Notes                    |
| ---------- | ------ | ------------------ | ------------------------ |
| 2026-10-18 | Draft  | Alexander Fedorets | Initial spec created     |

---

## Overview

Classify a text against a caller-supplied list of tags and return each tag's
probability. The backend forwards the text and tags to the TypeSafe AI
classification API and returns per-tag probabilities so the mobile app can
assign one or more relevant tags to a diary entry.

This is a stateless inference endpoint: no tags, text, or results are persisted
on the backend. The app owns tag definitions and storage of the assigned tags.

## User stories

- As a diarist, I want my diary entries automatically tagged with relevant topics so that I can browse and filter my journal by theme.
- As an app client, I want per-tag probabilities so that I can apply a local threshold and assign multiple tags to a single entry.

## Acceptance criteria

- [ ] AC1: Accept `POST /api/tag` with existing device and proxy-secret authentication.
- [ ] AC2: Accept a JSON body with `text` (non-empty string) and `tags` (array of 2–50 unique non-empty strings).
- [ ] AC3: Reject requests with missing/invalid fields, empty text, fewer than 2 or more than 50 tags, duplicate tags, or empty tag strings. Return HTTP 400 with `{ "error": "..." }`.
- [ ] AC4: Call the TypeSafe AI API (`POST https://api.typesafe.ai/v1/systemone`) with the text as `state` and a Choice question whose criteria are the supplied tags. Use model `jev-latest`.
- [ ] AC5: Return a JSON response with `tags` — an array of objects, each containing `tag` (string) and `probability` (number 0–1), ordered by descending probability. The probabilities come directly from the TypeSafe `probabilities` map.
- [ ] AC6: Enforce a maximum request body size of 256 KiB. Return HTTP 413 if exceeded.
- [ ] AC7: Enforce a maximum text length of 10,000 UTF-8 characters. Return HTTP 400 if exceeded.
- [ ] AC8: Enforce a timeout of 15 seconds for the TypeSafe API call. Return HTTP 504 on timeout.
- [ ] AC9: Return HTTP 502 for TypeSafe API errors (non-2xx responses, invalid JSON, unexpected response shape).
- [ ] AC10: Never persist or log the request text, tags, or results. Log only operation status, duration, and safe metadata (tag count, text length).
- [ ] AC11: Use the existing daily record quota system (CallCountType for tag operations) to rate-limit usage per device per day.
- [ ] AC12: Return sanitized errors using the existing `{ "error": "..." }` convention. Never expose internal details or upstream error messages.
- [ ] AC13: Unknown fields in the request body are rejected with HTTP 400.

## API contract

### `POST /api/tag`

Required headers:

- `X-Device-Id`: existing 64-character hexadecimal device identifier.
- `X-Proxy-Secret`: configured shared secret.
- `Content-Type: application/json`.

**Request:**

```json
{
  "text": "Today I went for a long run in the park and felt great afterwards.",
  "tags": ["exercise", "nature", "mood", "work", "food", "travel"]
}
```

| Field  | Type       | Rule                                                          |
| ------ | ---------- | ------------------------------------------------------------- |
| `text` | string     | Non-empty, trimmed length >= 1, max 10,000 UTF-8 characters  |
| `tags` | string[]   | 2–50 unique non-empty strings, no duplicates (case-sensitive) |

**Response (200):**

```json
{
  "tags": [
    { "tag": "exercise", "probability": 0.72 },
    { "tag": "mood", "probability": 0.55 },
    { "tag": "nature", "probability": 0.41 },
    { "tag": "food", "probability": 0.03 },
    { "tag": "work", "probability": 0.02 },
    { "tag": "travel", "probability": 0.01 }
  ]
}
```

The `tags` array contains one entry per input tag, ordered by descending probability.

**Error responses:**

| Status | Body                          | When                                    |
| ------ | ----------------------------- | --------------------------------------- |
| 400    | `{ "error": "..." }`         | Invalid input (missing fields, bad types, too few/many tags, duplicates, empty text, unknown fields, text too long) |
| 401    | `{ "error": "Unauthorized" }`| Missing or incorrect proxy secret       |
| 405    | `{ "error": "Method not allowed" }` | Non-POST method                  |
| 413    | `{ "error": "Request too large" }` | Body exceeds 256 KiB             |
| 429    | `{ "error": "..." }`         | Daily quota exceeded                    |
| 500    | `{ "error": "..." }`         | Configuration error (missing API key)   |
| 502    | `{ "error": "upstream_error" }` | TypeSafe API error                   |
| 504    | `{ "error": "TypeSafe request timeout" }` | TypeSafe API timeout          |

All responses use `Cache-Control: no-store`.

## Data model changes

None. This is a stateless endpoint. Quota tracking uses the existing `CallCount` model with a new `CallCountType` enum value (`TAG`).

## Dependencies

- Existing device authentication and registration (`ensureDevice`).
- Existing quota system (`callCount`, `quota`).
- Existing HTTP utilities (`http.ts`).
- TypeSafe AI API (`https://api.typesafe.ai/v1/systemone`) with a `TYPESAFE_API_KEY` environment variable.

## Non-functional requirements

- **Privacy:** Text, tags, and results exist only in memory during processing and in the response. No logs, database, or cache retains them.
- **Performance:** TypeSafe API timeout is 15 seconds. Vercel function timeout accommodates validation and response overhead around it.
- **Security:** Input validation rejects oversized, malformed, or unexpected payloads before any upstream call.
- **Observability:** Log operation status, duration, tag count, and text length. Never log text content or tag values.

## Out of scope

- Tag definitions, storage, or management on the backend.
- Multi-label thresholding logic (the app applies its own threshold to probabilities).
- Caching or memoizing classification results.
- Batch classification of multiple texts in one request.

## Open questions

None for specification.
