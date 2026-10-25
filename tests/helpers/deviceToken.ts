import { signDeviceToken } from '../../src/lib/deviceToken.js';

export const TEST_DEVICE_TOKEN_SECRET = 'test-device-token-secret';

// Set deterministically (not `??=`) so the token secret never depends on an
// ambient value across test files/order. Some suites build tokens at collection
// time, so this must be set at import, not only in a beforeEach. Tests needing a
// different secret override it in their own beforeEach (which runs later).
process.env.DEVICE_TOKEN_SECRET = TEST_DEVICE_TOKEN_SECRET;

export function tokenFor(deviceId: string): string {
  return signDeviceToken(deviceId);
}
