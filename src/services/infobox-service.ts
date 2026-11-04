import config from 'config';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { SUPPORTED_LOCALES } from '../../locales/languages.js';
import { fetchCommonsMetadata } from '../lib/commons.js';
import {
  type InfoboxLocalValues,
  type RenderInfoboxInput,
  renderInfobox,
  wikidataLabelLanguages,
} from '../lib/infobox-render.js';
import type { WikidataImage, WikidataSnapshot } from '../lib/wikidata.js';
import { fetchWikidataSnapshot } from './wikidata-service.js';
import { createWikimediaRequestService, WIKIMEDIA_REQUEST_TIMEOUT_MS } from './wikimedia-request-service.js';

interface WikidataConfig {
  userAgent: string;
  refreshAfterHours: number;
  // Off in tests, so nothing reaches Wikidata: only cached items are shown.
  fetchEnabled: boolean;
}

const readConfig = (): WikidataConfig => config.get<WikidataConfig>('wikidata');

// After a failed fetch, wait this long before asking Wikidata again.
const FAILED_RETRY_MS = 10 * 60 * 1000;
// A first view waits this long for Wikidata; a slower answer is shown on the
// next view.
const DEFAULT_WAIT_MS = 3000;

const API_BASE_URL = 'https://www.wikidata.org/w/api.php';
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH_SIZE = 20;

const wikimediaFetch = createWikimediaRequestService();

const fetchImage = async (file: string): Promise<WikidataImage | null> => {
  const { data } = await fetchCommonsMetadata(file, { userAgent: readConfig().userAgent, fetchImpl: wikimediaFetch });
  return {
    file,
    thumbnailUrl: data.thumbnailUrlTemplate ?? null,
    commonsPageUrl: data.commonsPageUrl,
    author: data.author ?? null,
    license: data.license ?? null,
    licenseUrl: data.licenseUrl ?? null,
  };
};

const defaultFetchSnapshot = (qid: string) => {
  const settings = readConfig();
  return fetchWikidataSnapshot(qid, {
    fetchImpl: wikimediaFetch,
    apiBaseUrl: API_BASE_URL,
    sparqlUrl: SPARQL_URL,
    userAgent: settings.userAgent,
    timeoutMs: WIKIMEDIA_REQUEST_TIMEOUT_MS,
    languages: wikidataLabelLanguages(SUPPORTED_LOCALES),
    fetchImage,
  });
};

export interface InfoboxServiceOptions {
  fetchSnapshot?: (qid: string) => Promise<WikidataSnapshot>;
  fetchEnabled?: boolean;
  refreshAfterMs?: number;
  now?: () => number;
}

/**
 * Wikidata items for infoboxes, cached in the database. A cached item is
 * shown as it is and refreshed in the background once it is older than the
 * refresh age; an item seen for the first time is fetched while the page
 * waits a few seconds at most.
 */
export const createInfoboxService = (options: InfoboxServiceOptions = {}) => {
  const fetchSnapshot = options.fetchSnapshot ?? defaultFetchSnapshot;
  const fetchEnabled = () => options.fetchEnabled ?? readConfig().fetchEnabled;
  const refreshAfterMs = () => options.refreshAfterMs ?? readConfig().refreshAfterHours * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<WikidataSnapshot | null>>();
  const failedUntil = new Map<string, number>();

  const readCache = async (dal: DataAccessLayer, qid: string) => {
    const result = await dal.query('SELECT snapshot, fetched_at FROM wikidata_items WHERE qid = $1', [qid]);
    return result.rows[0] as { snapshot: WikidataSnapshot; fetched_at: Date } | undefined;
  };
  const isFresh = (row: { fetched_at: Date }) => now() - new Date(row.fetched_at).getTime() <= refreshAfterMs();

  const refresh = (dal: DataAccessLayer, qid: string): Promise<WikidataSnapshot | null> => {
    const running = pending.get(qid);
    if (running) return running;
    const request = (async () => {
      try {
        // A caller's earlier cache miss may predate another completed refresh.
        const cached = await readCache(dal, qid);
        if (cached && isFresh(cached)) return cached.snapshot;
        const snapshot = await fetchSnapshot(qid);
        await dal.query(
          `INSERT INTO wikidata_items (qid, snapshot, fetched_at) VALUES ($1, $2, $3)
           ON CONFLICT (qid) DO UPDATE SET snapshot = EXCLUDED.snapshot, fetched_at = EXCLUDED.fetched_at`,
          [qid, JSON.stringify(snapshot), new Date(now())]
        );
        failedUntil.delete(qid);
        return snapshot;
      } catch (error) {
        failedUntil.set(qid, now() + FAILED_RETRY_MS);
        console.error(`Wikidata fetch failed for ${qid}:`, error instanceof Error ? error.message : error);
        return null;
      } finally {
        pending.delete(qid);
      }
    })();
    pending.set(qid, request);
    return request;
  };

  const canFetch = (qid: string) => fetchEnabled() && (failedUntil.get(qid) ?? 0) <= now();

  const getSnapshot = async (
    dal: DataAccessLayer,
    qid: string,
    waitMs = DEFAULT_WAIT_MS
  ): Promise<WikidataSnapshot | null> => {
    const row = await readCache(dal, qid);
    if (row) {
      if (!isFresh(row) && canFetch(qid)) {
        void refresh(dal, qid);
      }
      return row.snapshot;
    }
    if (!canFetch(qid)) return null;
    if (waitMs <= 0) {
      void refresh(dal, qid);
      return null;
    }
    const timeout = new Promise<null>(resolve => {
      setTimeout(() => resolve(null), waitMs).unref?.();
    });
    return Promise.race([refresh(dal, qid), timeout]);
  };

  const warmCache = (dal: DataAccessLayer, qid: string): void => {
    if (!fetchEnabled()) return;
    void getSnapshot(dal, qid, 0).catch(error => {
      console.error(`Wikidata cache warming failed for ${qid}:`, error);
    });
  };

  const sweep = async (dal: DataAccessLayer, batchSize = SWEEP_BATCH_SIZE): Promise<void> => {
    if (!fetchEnabled()) return;
    const excluded = new Set(pending.keys());
    for (const [qid, until] of failedUntil) {
      if (until > now()) excluded.add(qid);
      else failedUntil.delete(qid);
    }
    const result = await dal.query(
      `SELECT DISTINCT p.properties->>'wikidata' AS qid, w.fetched_at
       FROM pages p
       LEFT JOIN wikidata_items w ON w.qid = p.properties->>'wikidata'
       WHERE p._old_rev_of IS NULL AND p._rev_deleted = false
         AND p.properties->>'wikidata' ~ '^Q[1-9][0-9]{0,11}$'
         AND NOT (p.properties->>'wikidata' = ANY($1::text[]))
         AND (w.fetched_at IS NULL OR w.fetched_at < $2)
       ORDER BY w.fetched_at ASC NULLS FIRST, qid
       LIMIT $3`,
      [[...excluded], new Date(now() - refreshAfterMs()), batchSize]
    );
    for (const row of result.rows as Array<{ qid: string }>) {
      await getSnapshot(dal, row.qid, 0);
      await pending.get(row.qid);
    }
  };

  return { getSnapshot, refresh, warmCache, sweep };
};

export const infoboxService = createInfoboxService();

export const startInfoboxRefresh = (dal: DataAccessLayer): (() => void) => {
  const settings = readConfig();
  if (!settings.fetchEnabled) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      await infoboxService.sweep(dal);
    } catch (error) {
      console.error('Wikidata cache sweep failed:', error);
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void run(), SWEEP_INTERVAL_MS);
        timer.unref();
      }
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};

export async function renderArticleInfobox(
  dal: DataAccessLayer,
  input: Omit<RenderInfoboxInput, 'snapshot' | 'localValues'> & {
    qid: string;
    localValues: InfoboxLocalValues | null;
  },
  service = infoboxService
): Promise<string> {
  try {
    const snapshot = await service.getSnapshot(dal, input.qid);
    return renderInfobox({ ...input, snapshot });
  } catch (error) {
    console.error(`Infobox failed for ${input.qid}:`, error instanceof Error ? error.message : error);
    return '';
  }
}
