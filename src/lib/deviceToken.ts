import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEVICE_ID_REGEX } from './deviceId.js';

function getSecret(): string {
  const secret = process.env.DEVICE_TOKEN_SECRET;
  if (!secret) {
    throw new Error('DEVICE_TOKEN_SECRET is not configured');
  }
  return secret;
}

function sign(payloadSegment: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadSegment).digest();
}

/**
 * Token format: base64url(JSON {"did"}) + "." + base64url(HMAC_SHA256(payloadSegment, secret)).
 * Long-lived: no expiry.
 */
export function signDeviceToken(deviceId: string): string {
  const secret = getSecret();
  const payload = Buffer.from(JSON.stringify({ did: deviceId })).toString('base64url');
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

export function verifyDeviceToken(token: string | undefined | null): { deviceId: string } | null {
  if (!token) return null;

  const secret = process.env.DEVICE_TOKEN_SECRET;
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payloadSegment, signatureSegment] = parts;

  const expected = sign(payloadSegment, secret);
  const provided = Buffer.from(signatureSegment, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      did?: unknown;
    };
    if (typeof payload?.did !== 'string' || !DEVICE_ID_REGEX.test(payload.did)) return null;
    return { deviceId: payload.did };
  } catch {
    return null;
  }
}
