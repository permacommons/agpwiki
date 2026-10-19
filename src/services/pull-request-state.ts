import { PULL_REQUEST_REPOSITORY, pullRequestNumber } from '../lib/proposal-status.js';

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

export interface PullRequestInfo {
  url: string;
  number: number;
  state: PullRequestState;
  title: string | null;
}

type CacheEntry = { info: PullRequestInfo; expiresAt: number };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FRESH_MS = 10 * 60 * 1000;
const FAILED_MS = 2 * 60 * 1000;
const DEFAULT_WAIT_MS = 1500;
const USER_AGENT = 'AgpWiki/1.0 (proposal pull requests; https://github.com/permacommons/agpwiki/issues)';

/**
 * Pull request states from the GitHub API, cached in memory for ten minutes
 * so a proposal page asks GitHub at most once per pull request in that time.
 * Set GITHUB_TOKEN to raise GitHub's rate limit for unauthenticated calls.
 */
export const createPullRequestStateCache = (
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now
) => {
  const cache = new Map<number, CacheEntry>();
  const pending = new Map<number, Promise<PullRequestInfo>>();

  const fetchOne = async (number: number, url: string): Promise<PullRequestInfo> => {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${PULL_REQUEST_REPOSITORY}/pulls/${number}`,
        { headers, signal: AbortSignal.timeout(5000) }
      );
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      const data = (await response.json()) as {
        state?: string;
        draft?: boolean;
        merged_at?: string | null;
        title?: string;
      };
      const state: PullRequestState = data.merged_at
        ? 'merged'
        : data.state === 'closed'
          ? 'closed'
          : data.draft
            ? 'draft'
            : data.state === 'open'
              ? 'open'
              : 'unknown';
      const info = { url, number, state, title: typeof data.title === 'string' ? data.title : null };
      cache.set(number, { info, expiresAt: now() + FRESH_MS });
      return info;
    } catch {
      const stale = cache.get(number)?.info;
      const info = stale ?? { url, number, state: 'unknown' as const, title: null };
      cache.set(number, { info, expiresAt: now() + FAILED_MS });
      return info;
    } finally {
      pending.delete(number);
    }
  };

  const refresh = (number: number, url: string) => {
    let request = pending.get(number);
    if (!request) {
      request = fetchOne(number, url);
      pending.set(number, request);
    }
    return request;
  };

  /**
   * States for the given pull request URLs, in the same order. Fresh cache
   * entries are used as they are; others are refreshed, waiting at most
   * `waitMs` so a slow GitHub never holds up the page (the refresh finishes in
   * the background and the next view gets it).
   */
  const getStates = async (urls: string[], waitMs = DEFAULT_WAIT_MS): Promise<PullRequestInfo[]> =>
    Promise.all(
      urls.map(async url => {
        const number = pullRequestNumber(url);
        if (!number) return { url, number: 0, state: 'unknown' as const, title: null };
        const entry = cache.get(number);
        if (entry && entry.expiresAt > now()) return entry.info;
        const fallback = entry?.info ?? { url, number, state: 'unknown' as const, title: null };
        const timeout = new Promise<PullRequestInfo>(resolve => {
          setTimeout(() => resolve(fallback), waitMs).unref?.();
        });
        return Promise.race([refresh(number, url), timeout]);
      })
    );

  return { getStates, clear: () => cache.clear() };
};

export const pullRequestStates = createPullRequestStateCache();
