/**
 * Fetch with fallback across multiple RPC/API endpoints.
 *
 * Tries each URL in order. Falls back to the next on network errors
 * or 5xx responses. Returns immediately on success or 4xx (client error).
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** Split a comma-separated URL string into an array of trimmed URLs. */
export function parseUrls(commaSeparated: string): string[] {
  return commaSeparated.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Try fetching from each URL in order until one succeeds.
 * Throws only if every URL fails.
 */
export async function fetchWithFallback(
  urls: string[],
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  let lastError: Error | undefined;

  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res;
      }

      // 5xx — log and try next endpoint
      console.warn(`[fetch] ${url} returned ${res.status}, trying next`);
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fetch] ${url} failed: ${msg}, trying next`);
      lastError = err instanceof Error ? err : new Error(msg);
    }
  }

  throw lastError ?? new Error("All endpoints failed");
}
