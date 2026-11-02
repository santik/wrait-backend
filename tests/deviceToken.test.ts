import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { signDeviceToken, verifyDeviceToken } from '../src/lib/deviceToken.js';

const DEVICE_ID = 'a'.repeat(64);
const SECRET = 'unit-test-secret';

function b64(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function forge(payload: string, secret: string): string {
  const segment = b64(payload);
  return `${segment}.${createHmac('sha256', secret).update(segment).digest('base64url')}`;
}

describe('deviceToken', () => {
  beforeEach(() => {
    process.env.DEVICE_TOKEN_SECRET = SECRET;
  });

  it('round-trips a device id with the documented payload', () => {
    const token = signDeviceToken(DEVICE_ID);
    expect(verifyDeviceToken(token)).toEqual({ deviceId: DEVICE_ID });

    const [payload] = token.split('.');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(parsed.did).toBe(DEVICE_ID);
    expect(parsed.iat).toBeUndefined();
  });

  it('rejects a tampered payload', () => {
    const [, sig] = signDeviceToken(DEVICE_ID).split('.');
    const tampered = `${b64(JSON.stringify({ did: 'b'.repeat(64), iat: 1 }))}.${sig}`;
    expect(verifyDeviceToken(tampered)).toBeNull();
  });

  it('rejects a bad signature', () => {
    const [payload] = signDeviceToken(DEVICE_ID).split('.');
    expect(verifyDeviceToken(`${payload}.${b64('not-the-signature')}`)).toBeNull();
    expect(verifyDeviceToken(`${payload}.`)).toBeNull();
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = forge(JSON.stringify({ did: DEVICE_ID, iat: 1 }), 'other-secret');
    expect(verifyDeviceToken(token)).toBeNull();
  });

  it('rejects when the secret changes after signing', () => {
    const token = signDeviceToken(DEVICE_ID);
    process.env.DEVICE_TOKEN_SECRET = 'rotated';
    expect(verifyDeviceToken(token)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    for (const bad of [undefined, null, '', 'abc', 'a.b.c', '.', 'a.', '.b']) {
      expect(verifyDeviceToken(bad as string | undefined)).toBeNull();
    }
  });

  it('rejects a validly signed token whose did is malformed or payload is not JSON', () => {
    expect(verifyDeviceToken(forge(JSON.stringify({ did: 'short', iat: 1 }), SECRET))).toBeNull();
    expect(verifyDeviceToken(forge(JSON.stringify({ iat: 1 }), SECRET))).toBeNull();
    expect(verifyDeviceToken(forge('not json', SECRET))).toBeNull();
  });

  it('returns null on verify and throws on sign when the secret is unset', () => {
    const token = signDeviceToken(DEVICE_ID);
    delete process.env.DEVICE_TOKEN_SECRET;
    expect(verifyDeviceToken(token)).toBeNull();
    expect(() => signDeviceToken(DEVICE_ID)).toThrow();
  });
});
