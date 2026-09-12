/**
 * Small fetch wrapper shared by oauth.ts, browse.ts and inventory.ts:
 * retries a failed call once with a short backoff, and turns HTTP 429 into a
 * typed error so the sync engine can stop that account gracefully instead of
 * hammering eBay's rate limiter.
 */

export class EbayRateLimitError extends Error {
  constructor(message = 'eBay API rate limit (HTTP 429)') {
    super(message);
    this.name = 'EbayRateLimitError';
  }
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
}

/**
 * Fetches `input`, retrying once (by default) on a network error or HTTP 5xx.
 * HTTP 429 is never retried — it throws EbayRateLimitError immediately so the
 * caller can stop cleanly. Never logs headers or bodies (tokens live there).
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  attempts = 2,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await backoff(attempt);
        continue;
      }
      throw err;
    }
    if (res.status === 429) throw new EbayRateLimitError();
    if (res.status >= 500 && attempt < attempts - 1) {
      lastError = new Error(`HTTP ${res.status}`);
      await backoff(attempt);
      continue;
    }
    return res;
  }
  throw lastError instanceof Error ? lastError : new Error('eBay request failed');
}
