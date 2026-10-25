import { describe, it, expect, afterEach } from 'vitest';
import type { VercelRequest } from '@vercel/node';
import { isDeviceTokenRequired, requireQuotaDeviceId } from '../src/contracts/http.js';
import { tokenFor } from './helpers/deviceToken.js';

const validHex = 'a'.repeat(64);

function req(headers: Record<string, string>): VercelRequest {
  return { headers } as unknown as VercelRequest;
}

const forbidden = {
  status: 403,
  body: { error: 'Invalid or missing device token' },
};

afterEach(() => {
  delete process.env.REQUIRE_DEVICE_TOKEN;
});

describe('isDeviceTokenRequired', () => {
  it('defaults to strict (true) when unset', () => {
    expect(isDeviceTokenRequired()).toBe(true);
  });

  it('is false only when explicitly "false"', () => {
    process.env.REQUIRE_DEVICE_TOKEN = 'false';
    expect(isDeviceTokenRequired()).toBe(false);
    process.env.REQUIRE_DEVICE_TOKEN = 'true';
    expect(isDeviceTokenRequired()).toBe(true);
  });
});

describe('requireQuotaDeviceId', () => {
  it('accepts a valid token regardless of the flag', () => {
    expect(requireQuotaDeviceId(req({ 'x-device-token': tokenFor(validHex) }))).toEqual({
      deviceId: validHex,
    });
  });

  it('strict (default): rejects a legacy X-Device-Id with 403', () => {
    expect(requireQuotaDeviceId(req({ 'x-device-id': validHex }))).toEqual(forbidden);
  });

  it('transition (flag false): accepts a valid legacy X-Device-Id', () => {
    process.env.REQUIRE_DEVICE_TOKEN = 'false';
    expect(requireQuotaDeviceId(req({ 'x-device-id': validHex }))).toEqual({
      deviceId: validHex,
    });
  });

  it('transition: still prefers a valid token over the legacy id', () => {
    process.env.REQUIRE_DEVICE_TOKEN = 'false';
    expect(
      requireQuotaDeviceId(
        req({ 'x-device-token': tokenFor(validHex), 'x-device-id': 'b'.repeat(64) }),
      ),
    ).toEqual({ deviceId: validHex });
  });

  it('transition: rejects when neither a token nor a valid id is present', () => {
    process.env.REQUIRE_DEVICE_TOKEN = 'false';
    expect(requireQuotaDeviceId(req({ 'x-device-id': 'not-hex' }))).toEqual(forbidden);
  });
});
