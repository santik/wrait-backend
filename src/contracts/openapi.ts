import type { components, operations } from '../generated/openapi.js';

type JsonContent<T> = T extends { content: { 'application/json': infer Body } } ? Body : never;

export type ErrorResponse = components['schemas']['ErrorResponse'];
export type DailyRecordLimitExceededResponse = components['schemas']['DailyRecordLimitExceededResponse'];
export type SpeechNotRecognizedResponse = components['schemas']['SpeechNotRecognizedResponse'];
export type UpstreamErrorResponse = components['schemas']['UpstreamErrorResponse'];

export type RegisterResponseBody = JsonContent<operations['registerDevice']['responses'][201]>;

export type CleanupRequestBody =
  operations['cleanupTranscript']['requestBody']['content']['application/json'];
export type CleanupResponseBody = JsonContent<operations['cleanupTranscript']['responses'][200]>;
export type CleanupErrorResponse = ErrorResponse | DailyRecordLimitExceededResponse;

export type TranscribeResponseBody = JsonContent<operations['transcribeAudio']['responses'][200]>;
export type TranscribeErrorResponse =
  | ErrorResponse
  | DailyRecordLimitExceededResponse
  | SpeechNotRecognizedResponse
  | UpstreamErrorResponse;

export type TagRequestBody =
  operations['tagText']['requestBody']['content']['application/json'];
export type TagResponseBody = JsonContent<operations['tagText']['responses'][200]>;
export type TagErrorResponse = ErrorResponse | DailyRecordLimitExceededResponse;
