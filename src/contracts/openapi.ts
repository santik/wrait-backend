import type { components, operations } from '../generated/openapi.js';

type JsonContent<T> = T extends { content: { 'application/json': infer Body } } ? Body : never;

export type ErrorResponse = components['schemas']['ErrorResponse'];
export type DailyRecordLimitExceededResponse = components['schemas']['DailyRecordLimitExceededResponse'];
export type SpeechNotRecognizedResponse = components['schemas']['SpeechNotRecognizedResponse'];
export type UpstreamErrorResponse = components['schemas']['UpstreamErrorResponse'];

export type RegisterHeaders = operations['registerDevice']['parameters']['header'];
export type RegisterResponseBody = JsonContent<operations['registerDevice']['responses'][201]>;

export type CleanupHeaders = operations['cleanupTranscript']['parameters']['header'];
export type CleanupRequestBody =
  operations['cleanupTranscript']['requestBody']['content']['application/json'];
export type CleanupResponseBody = JsonContent<operations['cleanupTranscript']['responses'][200]>;
export type CleanupErrorResponse = ErrorResponse | DailyRecordLimitExceededResponse;

export type TranscribeHeaders = operations['transcribeAudio']['parameters']['header'];
export type TranscribeResponseBody = JsonContent<operations['transcribeAudio']['responses'][200]>;
export type TranscribeErrorResponse =
  | ErrorResponse
  | DailyRecordLimitExceededResponse
  | SpeechNotRecognizedResponse
  | UpstreamErrorResponse;
