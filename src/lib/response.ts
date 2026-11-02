import type { VercelResponse } from '@vercel/node';

export type CacheControl =
  | 'no-store'
  | { maxAge: number; sMaxAge?: number; staleWhileRevalidate?: number };

export function json(res: VercelResponse, data: unknown, status = 200, cache: CacheControl = 'no-store'): void {
  const cacheHeader =
    cache === 'no-store'
      ? 'no-store'
      : [
          `max-age=${cache.maxAge}`,
          cache.sMaxAge !== undefined ? `s-maxage=${cache.sMaxAge}` : null,
          cache.staleWhileRevalidate !== undefined
            ? `stale-while-revalidate=${cache.staleWhileRevalidate}`
            : null,
        ]
          .filter(Boolean)
          .join(', ');

  res.setHeader('Cache-Control', cacheHeader);
  res.status(status).json(data);
}
