import config from 'config';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { SUPPORTED_LOCALES } from '../../locales/languages.js';
import { fetchCommonsMetadata } from '../lib/commons.js';
import {
  findInfoboxMismatches,
  type InfoboxLocalValues,
  type InfoboxMismatch,
  type RenderInfoboxInput,
  renderInfobox,
  wikidataLabelLanguages,
} from '../lib/infobox-render.js';
import { fetchWikidataSnapshot, type WikidataImage, type WikidataSnapshot } from '../lib/wikidata.js';

interface WikidataConfig {
  apiBaseUrl: string;
  sparqlUrl: string;
  userAgent: string;
  fetchTimeoutMs: number;
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

const fetchImage = async (file: string): Promise<WikidataImage | null> => {
  const { data } = await fetchCommonsMetadata(file, { userAgent: readConfig().userAgent });
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
    apiBaseUrl: settings.apiBaseUrl,
    sparqlUrl: settings.sparqlUrl,
    userAgent: settings.userAgent,
    timeoutMs: settings.fetchTimeoutMs,
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

  const refresh = (dal: DataAccessLayer, qid: string): Promise<WikidataSnapshot | null> => {
    const running = pending.get(qid);
    if (running) return running;
    const request = (async () => {
      try {
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
    const result = await dal.query('SELECT snapshot, fetched_at FROM wikidata_items WHERE qid = $1', [qid]);
    const row = result.rows[0] as { snapshot: WikidataSnapshot; fetched_at: Date } | undefined;
    if (row) {
      if (now() - new Date(row.fetched_at).getTime() > refreshAfterMs() && canFetch(qid)) {
        void refresh(dal, qid);
      }
      return row.snapshot;
    }
    if (!canFetch(qid)) return null;
    const timeout = new Promise<null>(resolve => {
      setTimeout(() => resolve(null), waitMs).unref?.();
    });
    return Promise.race([refresh(dal, qid), timeout]);
  };

  return { getSnapshot, refresh };
};

export const infoboxService = createInfoboxService();

/**
 * Keeps the recorded mismatches of a page in step with what its infobox
 * found: new or changed ones are saved, ones that are gone are removed.
 */
export async function recordInfoboxMismatches(
  dal: DataAccessLayer,
  pageId: string,
  qid: string,
  mismatches: InfoboxMismatch[]
): Promise<void> {
  await dal.query('DELETE FROM infobox_mismatches WHERE page_id = $1 AND NOT (property = ANY($2::text[]))', [
    pageId,
    mismatches.map(mismatch => mismatch.property),
  ]);
  for (const mismatch of mismatches) {
    await dal.query(
      `INSERT INTO infobox_mismatches (page_id, property, qid, agpedia_value, wikidata_value)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id, property) DO UPDATE
         SET qid = EXCLUDED.qid, agpedia_value = EXCLUDED.agpedia_value,
             wikidata_value = EXCLUDED.wikidata_value, detected_at = NOW()
       WHERE infobox_mismatches.qid IS DISTINCT FROM EXCLUDED.qid
          OR infobox_mismatches.agpedia_value IS DISTINCT FROM EXCLUDED.agpedia_value
          OR infobox_mismatches.wikidata_value IS DISTINCT FROM EXCLUDED.wikidata_value`,
      [pageId, mismatch.property, qid, mismatch.agpediaValue, mismatch.wikidataValue]
    );
  }
}

/**
 * The infobox of an article from its Wikidata item. Viewing the current
 * version also records where values added on Agpedia differ from Wikidata.
 */
export async function renderArticleInfobox(
  dal: DataAccessLayer,
  input: Omit<RenderInfoboxInput, 'snapshot' | 'localValues'> & {
    pageId: string;
    qid: string;
    localValues: InfoboxLocalValues | null;
  },
  service = infoboxService
): Promise<string> {
  try {
    const snapshot = await service.getSnapshot(dal, input.qid);
    if (!input.isOldRevision && snapshot) {
      await recordInfoboxMismatches(dal, input.pageId, input.qid, findInfoboxMismatches(snapshot, input.localValues));
    }
    return renderInfobox({ ...input, snapshot });
  } catch (error) {
    console.error(`Infobox failed for ${input.qid}:`, error instanceof Error ? error.message : error);
    return '';
  }
}
