import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ensureDevice, type EnsuredDevice } from '../lib/device.js';
import { verifyDeviceToken } from '../lib/deviceToken.js';
import { DEVICE_ID_REGEX } from '../lib/deviceId.js';
import { json } from '../lib/response.js';
import type { ErrorResponse } from './openapi.js';

export type OperationResult<TSuccess, TError = ErrorResponse> = {
  status: number;
  body: TSuccess | TError;
};

export function errorResponse(error: string): ErrorResponse {
  return { error };
}

export function requirePostMethod(
  req: VercelRequest,
): OperationResult<never> | null {
  if (req.method !== 'POST') {
    return { status: 405, body: errorResponse('Method not allowed') };
  }
  return null;
}

function getHeader(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export function requireProxySecret(
  req: VercelRequest,
): OperationResult<never> | null {
  if (getHeader(req, 'x-proxy-secret') !== process.env.PROXY_SECRET) {
    return { status: 401, body: errorResponse('Unauthorized') };
  }
  return null;
}

export function requireDeviceId(
  req: VercelRequest,
): { deviceId: string } | OperationResult<never> {
  const deviceId = getHeader(req, 'x-device-id');
  if (!deviceId || !DEVICE_ID_REGEX.test(deviceId)) {
    return { status: 400, body: errorResponse('Invalid device ID') };
  }
  return { deviceId };
}

export function readDeviceToken(req: VercelRequest): { deviceId: string } | null {
  return verifyDeviceToken(getHeader(req, 'x-device-token'));
}

export function isDeviceTokenRequired(): boolean {
  // Secure default: a signed token is required. Set REQUIRE_DEVICE_TOKEN=false
  // to open the migration window in which legacy X-Device-Id requests are still
  // accepted — for already-installed app builds that predate device tokens.
  return process.env.REQUIRE_DEVICE_TOKEN !== 'false';
}

// Surface the weakened mode once per cold start so it can't run unnoticed.
if (process.env.REQUIRE_DEVICE_TOKEN === 'false') {
  console.warn(
    '[auth] REQUIRE_DEVICE_TOKEN=false — migration window active: legacy ' +
      'X-Device-Id is accepted on quota endpoints (reverts to pre-token ' +
      'protection). Keep this window short and flip to strict once adoption is high.',
  );
}

// Resolves the identity for a quota-protected endpoint. A valid token is always
// accepted. During the migration window (REQUIRE_DEVICE_TOKEN=false) a valid
// legacy X-Device-Id is accepted as a fallback; otherwise the request is a 403.
export function requireQuotaDeviceId(
  req: VercelRequest,
): { deviceId: string } | OperationResult<never> {
  const tokenDevice = readDeviceToken(req);
  if (tokenDevice) return tokenDevice;

  if (!isDeviceTokenRequired()) {
    const deviceId = getHeader(req, 'x-device-id');
    if (deviceId && DEVICE_ID_REGEX.test(deviceId)) {
      console.warn('[auth] Accepting legacy X-Device-Id (REQUIRE_DEVICE_TOKEN=false)');
      return { deviceId };
    }
  }

  // Distinct reasons aid abuse/debugging triage; the response stays uniform and
  // never echoes the token. logRequest already logs the path, so these lines
  // correlate by timestamp.
  const hadToken = getHeader(req, 'x-device-token') != null;
  console.warn('[auth] Device token rejected', { reason: hadToken ? 'invalid' : 'missing' });
  return { status: 403, body: errorResponse('Invalid or missing device token') };
}

// Validates the device, mapping any ensureDevice failure to a uniform 500 with
// the per-endpoint log label. Every quota handler needs exactly this.
export async function ensureDeviceOrError(
  deviceId: string,
  label: string,
): Promise<EnsuredDevice | OperationResult<never>> {
  try {
    return await ensureDevice(deviceId);
  } catch (error) {
    console.error(`[${label}] Failed to validate device:`, {
      error: error instanceof Error ? error.message : String(error),
      deviceId,
    });
    return { status: 500, body: errorResponse('Internal server error') };
  }
}

// Reads a JSON request body: the Content-Type guard, the size-bounded read, and
// the parse, which cleanup and tag share verbatim. The parsed value is wrapped
// so callers discriminate on `status` without colliding with a parsed object
// that happens to carry its own `status` field.
export async function readJsonBody(
  req: VercelRequest,
  maxSize: number,
): Promise<{ value: unknown } | OperationResult<never>> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.startsWith('application/json')) {
    return { status: 400, body: errorResponse('Invalid Content-Type') };
  }

  const requestBody = await readRequestBody(req, maxSize);
  if ('status' in requestBody) return requestBody;

  try {
    return { value: JSON.parse(requestBody.body.toString('utf-8')) as unknown };
  } catch {
    return { status: 400, body: errorResponse('Invalid JSON body') };
  }
}

// Maps a non-OK status or unparseable body to a uniform 502, otherwise returns
// the parsed JSON (wrapped, same reason as readJsonBody). Shared by the handlers
// that collapse every upstream failure to `upstream_error`; transcribe forwards
// the raw upstream body instead and keeps its own handling.
export async function readUpstreamJson(
  res: Response,
  label: string,
  deviceId: string,
): Promise<{ payload: unknown } | OperationResult<never>> {
  if (!res.ok) {
    console.error(`[${label}] Upstream returned non-OK status:`, { status: res.status, deviceId });
    return { status: 502, body: errorResponse('upstream_error') };
  }

  try {
    return { payload: await res.json() };
  } catch {
    console.error(`[${label}] Upstream returned invalid JSON:`, { deviceId });
    return { status: 502, body: errorResponse('upstream_error') };
  }
}

export async function readRequestBody(
  req: VercelRequest,
  maxSize: number,
): Promise<{ body: Buffer; totalSize: number } | OperationResult<never>> {
  let totalSize = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const bufferChunk = chunk as Buffer;
    totalSize += bufferChunk.length;
    if (totalSize > maxSize) {
      return { status: 413, body: errorResponse('Request too large') };
    }
    chunks.push(bufferChunk);
  }

  return { body: Buffer.concat(chunks), totalSize };
}

export function getRequestUrl(req: VercelRequest): URL {
  const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
  return new URL(req.url ?? '/', `https://${host}`);
}

export function logRequest(tag: string, req: VercelRequest): void {
  const url = req.headers ? getRequestUrl(req) : new URL(req.url ?? '/', 'https://localhost');
  const query = Object.fromEntries(url.searchParams.entries());
  console.log(`[${tag}] request`, {
    method: req.method,
    path: url.pathname,
    ...(Object.keys(query).length > 0 ? { query } : {}),
  });
}

export function logResponse(tag: string, status: number): void {
  console.log(`[${tag}] response`, { status });
}

// Wraps an operation handler as a Vercel request handler, applying the common
// request/response logging and JSON serialization every endpoint shares.
export function createOperationHandler(
  tag: string,
  handle: (req: VercelRequest) => Promise<OperationResult<unknown, unknown>>,
): (req: VercelRequest, res: VercelResponse) => Promise<void> {
  return async (req, res) => {
    logRequest(tag, req);
    const result = await handle(req);
    logResponse(tag, result.status);
    json(res, result.body, result.status);
  };
}
