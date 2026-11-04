import { setTimeout as sleep } from 'node:timers/promises';

export const WIKIMEDIA_REQUEST_TIMEOUT_MS = 8000;
const REQUEST_INTERVAL_MS = 1000;
const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 300_000;

interface WikimediaRequestOptions {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export const createWikimediaRequestService = (options: WikimediaRequestOptions = {}): typeof fetch => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const intervalMs = options.intervalMs ?? REQUEST_INTERVAL_MS;
  const endpoints = new Map<string, { until: number; failures: number }>();
  let nextRequestAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.pathname.endsWith('/api.php')) url.searchParams.set('maxlag', '5');
    const endpoint = url.origin;
    const checkBackoff = () => {
      if ((endpoints.get(endpoint)?.until ?? 0) > now()) {
        throw new Error(`Wikimedia endpoint ${endpoint} is in backoff.`);
      }
    };
    const backoff = (retryAfter: string | null) => {
      const failures = (endpoints.get(endpoint)?.failures ?? 0) + 1;
      const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
      const retryAt = Number.isFinite(seconds) ? now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? '');
      const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(failures - 1, 6));
      endpoints.set(endpoint, { until: Math.max(now() + delay, Number.isFinite(retryAt) ? retryAt : 0), failures });
    };
    const request = queue.then(async () => {
      checkBackoff();
      const delay = nextRequestAt - now();
      if (delay > 0) await wait(delay);
      checkBackoff();
      nextRequestAt = now() + intervalMs;
      let response: Response;
      try {
        // Queue time must not consume the upstream request's network timeout.
        response = await fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(options.timeoutMs ?? WIKIMEDIA_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) backoff(response.headers.get('Retry-After'));
          await response.body?.cancel();
          throw new Error(`Wikimedia returned status ${response.status}.`);
        }
        const body = await response.clone().json() as { error?: { code?: string; info?: string } };
        if (['maxlag', 'ratelimited', 'readonly'].includes(body.error?.code ?? '')) {
          backoff(response.headers.get('Retry-After'));
        }
        if (body.error) throw new Error(`Wikimedia API error ${body.error.code ?? 'unknown'}: ${body.error.info ?? ''}`);
      } catch (error) {
        if ((endpoints.get(endpoint)?.until ?? 0) <= now()) backoff(null);
        throw error;
      }
      endpoints.delete(endpoint);
      return response;
    });
    queue = request.then(() => undefined, () => undefined);
    return request;
  };
};
