// Canonical device-identifier format, shared by request validation and token
// verification so the two can never drift.
export const DEVICE_ID_PATTERN = '^[a-fA-F0-9]{64}$';
export const DEVICE_ID_REGEX = new RegExp(DEVICE_ID_PATTERN);
