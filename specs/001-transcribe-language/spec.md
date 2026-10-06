# Feature Specification: Optional transcription language

> **Feature number:** 001
> **Status:** Complete
> **Author:** Codex
> **Date:** 2026-09-29
> **Work item:** Not assigned

## Status history

| Date       | Status   | Author | Notes                                                                                                     |
| ---------- | -------- | ------ | --------------------------------------------------------------------------------------------------------- |
| 2026-09-29 | Draft    | Codex  | Initial specification for review                                                                          |
| 2026-09-29 | Approved | Codex  | User approved draft; clarification review complete. Finalized-spec approval pending before Plan.          |
| 2026-09-29 | Approved | Codex  | User approved finalized specification; Plan phase authorized.                                             |
| 2026-09-29 | Complete | Codex  | Implementation and required validation completed; repository-wide lint retains two pre-existing failures. |
| 2026-09-29 | Complete | Codex  | Follow-up: published and enforced the current Deepgram `nova-3-general` language enum.                    |
| 2026-10-06 | Approved | Claude | Follow-up amendment: empty transcript returns 422 `speech_not_recognized`; no extra provider call. Open questions resolved by user; finalized. |
| 2026-10-06 | Complete | Claude | Follow-up implemented and validated (see tasks.md evidence); lint retains two pre-existing failures. |

## Overview

Callers who know a recording's language can supply it when requesting a
transcription. This avoids incorrect automatic language selection. Requests
without a language continue to use automatic detection.

## User stories

- As a caller, I want to specify a recording's language so transcription uses
  that language even when automatic detection would choose incorrectly.
- As an existing client, I want requests without a language to retain their
  current behavior and response shape.

## Acceptance criteria

- [x] AC1: `POST /api/transcribe` accepts one optional `language` query parameter,
      for example `/api/transcribe?language=it`, with the existing audio upload.
- [x] AC2: When supplied and valid, the language is passed to the transcription
      provider and automatic detection is disabled for that request.
- [x] AC3: When omitted, automatic language detection and existing defaults
      remain unchanged.
- [x] AC4: Empty, unsupported, whitespace-containing, malformed, or repeated language values
      return HTTP 400 with `{ "error": "Invalid language" }`, without calling the
      transcription provider or recording a successful transcription.
- [x] AC5: The success response preserves `transcript`, `detected_language`, and
      the existing optional `quota`. With an explicit language, `detected_language`
      contains the requested language, even if the provider omits detection metadata.
      In automatic mode, missing detection metadata remains an upstream error.
- [x] AC6: Other client query parameters remain ignored; callers cannot override
      the model, formatting options, or language-detection behavior independently.
- [x] AC7: Existing authentication, device handling, quotas, multipart rules,
      audio limits, timeout behavior, upstream error handling, and success accounting
      continue to apply.
- [x] AC8: API documentation and generated contract types describe the optional
      parameter and the response language semantics, with regression test evidence.

## API contract

### `POST /api/transcribe[?language=it]`

**Headers and body:** Existing required `x-proxy-secret` and `x-device-id`
headers and `multipart/form-data` body containing exactly one `audio` file.
The language is a query parameter, not an additional multipart field.

**Optional query parameter:**

| Name       | Type   | Rules                                                                                                         |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `language` | string | One value from the documented `nova-3-general` language enum, including regional/script variants and `multi`. |

Documented values are forwarded unchanged. The API and runtime lists must stay
synchronized. An empty or unsupported value is invalid rather than equivalent
to omission.

Validation applies to the decoded query value. Values are not trimmed or
case-normalized: `IT`, `en-us`, and surrounding whitespace are invalid. Repeated
`language` parameters are invalid even when their values match. These validation
errors apply to otherwise valid, authorized requests; existing method and
authentication checks retain precedence.

A supported explicit language rejected by the provider does not trigger an
automatic-detection retry and keeps the existing upstream-error behavior.
Explicit language mode still requires a valid transcript in a successful provider
response; only the requirement for detection metadata changes.

**Success (200), illustrative response:**

```json
{
  "transcript": "Buongiorno",
  "detected_language": "it"
}
```

The existing optional `quota` object retains its current meaning and shape.
For compatibility, `detected_language` represents the requested language in
explicit mode and the provider-detected language in automatic mode.

**Error responses:**

| Status | Body                              | When                                                               |
| ------ | --------------------------------- | ------------------------------------------------------------------ |
| 400    | `{ "error": "Invalid language" }` | Supplied language fails the rules above                            |
| 502    | Existing upstream-error response  | Provider rejects a syntactically valid language or otherwise fails |

All other existing error responses remain applicable.

## Data model changes

None. No new storage or migration is required.

## Dependencies

- Existing transcription provider's explicit-language capability.
- Existing API contract, upload, authentication, quota, and accounting behavior.

## UX / design references

No user-interface changes. API consumers may choose when to provide the language.

## Non-functional requirements

- **Performance:** Retain one provider request per accepted transcription and
  existing upload size and timeout limits.
- **Security:** Validate the new input at the request boundary; it must not let
  callers inject or override other upstream parameters.
- **Reliability:** Preserve automatic-mode compatibility and accept valid
  explicit-mode responses without requiring detection metadata.
- **Scalability:** No additional persistence or external lookups per request.
- **Observability:** Retain existing operational logging without introducing
  new sensitive data logging.

## Test strategy

- Verify omitted language preserves the automatic-mode upstream request and response.
- Verify explicit base and regional codes reach the provider unchanged, disable
  detection, and produce the compatible success response without detection metadata.
- Verify explicit mode reports the requested language even when provider detection
  metadata is present; automatic mode still rejects missing detection metadata.
- Verify invalid, unsupported, and repeated values produce 400 without an upstream
  request or success accounting; verify provider errors for supported values remain
  upstream errors.
- Verify unrelated query parameters cannot override backend settings, including
  a client `detect_language=true` alongside an explicit language.
- Run endpoint and API contract regression tests, the full test suite, lint,
  API contract validation, and TypeScript checks during implementation.

## Out of scope

- Client UI changes, translation, multilingual selection, and model selection.
- Persisting language preferences or changing the response schema.
- Changing multipart input rules or accepting additional provider options.

## Clarification review

The approved draft defines query placement, language syntax, explicit-mode
response semantics, and upstream failure behavior. Review clarified decoded-value
validation, strict casing, identical duplicates, authentication precedence, no
automatic retry, and continued transcript validation without changing scope.

## Follow-up amendment: empty transcript is a failure (Complete)

**Problem.** When the caller supplies a language and the speaker uses a different
one, the provider returns an empty transcript. Today the endpoint answers 200
with an empty transcript and echoes the requested (wrong) `detected_language`.
The app cannot tell this from success, and it stores the wrong language.

**Decision (user, 2026-10-06).** Do **not** make additional provider requests.
Instead, an empty transcript is reported as an error so the client treats it as
a transcription failure. The client already keeps the audio draft on failure, so
the user keeps the recording, may change the language, and retry later.

### Additional acceptance criteria

- [x] AC9: When the provider responds successfully but the transcript is empty
      (zero length after trimming whitespace), `POST /api/transcribe` returns
      HTTP 422 instead of 200, with a body containing the existing `error` string
      and a stable machine-readable `reason` of `speech_not_recognized`.
- [x] AC10: The rule applies in explicit and automatic mode. The 422 body also
      echoes the requested `language` when one was supplied, so the client can
      show a targeted message; `language` is omitted in automatic mode.
- [x] AC11: No success is counted for a 422 response, and no `quota` object is
      returned. The failed attempt does not consume the daily allowance.
- [x] AC12: Exactly one provider request is made per accepted request in every
      case. There is no retry or fallback detection.
- [x] AC13: A non-empty transcript behaves exactly as before (AC5 unchanged).
- [x] AC14: Provider errors, timeouts, and malformed provider responses keep
      their existing 502/504 behavior and are distinct from 422.
- [x] AC15: The OpenAPI contract declares the 422 response (error schema with
      required `error` and `reason`, optional `language`, `reason` limited to
      `speech_not_recognized`), and states that 200 responses carry a non-empty
      transcript. Generated types, README, and regression and contract tests
      cover it, including client guidance (change the language or use automatic
      detection, then retry).

### Impact on earlier text

- AC5: a successful (200) response always has a non-empty transcript.
- Existing 502 behavior for explicit mode with malformed responses is unchanged.
- Empty-transcript responses are no longer a documented success case.

### Additional test strategy

- Explicit language, empty or whitespace-only transcript: 422, `speech_not_recognized`,
  language echoed, one provider request, no success count, no quota.
- Automatic mode, empty transcript: 422, `reason` present, `language` absent.
- Non-empty transcript: unchanged 200 with accounting.
- Provider 4xx/5xx, timeout, malformed payload: still 502/504.
- Contract test validates the 422 body against the documented schema.

### Resolved questions

1. Automatic mode also returns 422 on an empty transcript (approved).
2. Reason is `speech_not_recognized`; it asserts no cause (approved).
3. Body shape `{ "error", "reason", "language"? }` (approved).

## Open questions

None. The original scope is complete; the follow-up amendment has no open questions.
