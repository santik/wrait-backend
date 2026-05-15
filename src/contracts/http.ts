import type { VercelRequest } from '@vercel/node';
import type { ErrorResponse } from './openapi.js';

export type OperationResult<TSuccess, TError = ErrorResponse> = {
  status: number;
  body: TSuccess | TError;
};

export const DEVICE_ID_PATTERN = '^[a-fA-F0-9]{64}$';
const DEVICE_ID_REGEX = new RegExp(DEVICE_ID_PATTERN);

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
