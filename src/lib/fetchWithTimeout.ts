// Performs a fetch that aborts after timeoutMs. The AbortController/timeout/
// clearTimeout plumbing is identical across every upstream call, so it lives
// here; callers keep their own status/message mapping for the resulting
// AbortError (timeout wording and status differ per upstream).
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
