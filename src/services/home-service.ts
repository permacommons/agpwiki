import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { firstSentence } from '../lib/excerpt.js';
import { extractMediaSlugsFromSources } from '../lib/media-render.js';
import { pageNamespaceSql } from '../lib/page-address.js';
import type { ProposalStatus } from '../lib/proposal-status.js';
import BlogPost from '../models/blog-post.js';
import Media from '../models/media.js';
import { type ArticleIssueKind, countArticlesWithIssues } from './article-issues-service.js';
import { listProposalPages } from './proposal-status-service.js';

const { mlString } = dal;

/** The page whose text the home page shows, among these sections. */
export const HOME_PAGE_SLUG = 'meta/welcome';

const NEW_ARTICLE_COUNT = 4;
// The featured card always has a picture, so it looks further back than the
// newest articles, a batch at a time, among articles whose text embeds media.
const FEATURED_BATCH = 50;
const FEATURED_MAX_SCANNED = 1000;
const PROPOSAL_COUNT = 3;
const BLOG_POST_COUNT = 3;
const FORUM_THREAD_COUNT = 3;
// The sections change slowly, and the home page is the most visited page.
const CACHE_MS = 5 * 60 * 1000;

export interface HomeArticle {
  slug: string;
  title: Record<string, string> | null;
  createdAt: Date;
  excerpt: string;
  imageSlug: string | null;
}

export interface HomePost {
  slug: string;
  title: Record<string, string> | null;
  createdAt: Date;
}

export interface HomeThread {
  id: string;
  title: Record<string, string> | null;
  category: string;
  pageSlug: string | null;
  lastActivityAt: Date;
}

export interface HomeProposal {
  slug: string;
  title: Record<string, string> | null;
  status: ProposalStatus;
}

export interface HomeSections {
  articles: HomeArticle[];
  /** The newest article with a picture, however far back it is. */
  featured: HomeArticle | null;
  posts: HomePost[];
  threads: HomeThread[];
  proposals: HomeProposal[];
  issues: Record<ArticleIssueKind, number>;
}

const resolveText = (lang: string, value: Record<string, string> | null | undefined) =>
  mlString.resolve(lang, value ?? null)?.str ?? '';

// The first image the text embeds, if it is a known image.
const firstImages = async (sources: Map<string, string>) => {
  const firstBySource = new Map<string, string>();
  for (const [key, source] of sources) {
    const [first] = extractMediaSlugsFromSources([source]);
    if (first) firstBySource.set(key, first);
  }
  const slugs = [...new Set(firstBySource.values())];
  if (!slugs.length) return new Map<string, string>();
  const images = await Media.filterWhere({ mediaType: 'image' })
    .whereIn('slug', slugs)
    .select('slug');
  const known = new Set(images.map(image => image.slug));
  return new Map([...firstBySource].filter(([, slug]) => known.has(slug)));
};

type ArticleRow = {
  slug: string;
  title: Record<string, string> | null;
  body: Record<string, string> | null;
  created_at: Date;
};

const toHomeArticles = async (rows: ArticleRow[], lang: string): Promise<HomeArticle[]> => {
  const bodies = new Map(rows.map(row => [row.slug, resolveText(lang, row.body)]));
  const images = await firstImages(bodies);
  return rows.map(row => ({
    slug: row.slug,
    title: row.title,
    createdAt: row.created_at,
    excerpt: firstSentence(bodies.get(row.slug)),
    imageSlug: images.get(row.slug) ?? null,
  }));
};

const loadArticles = async (dalInstance: DataAccessLayer, lang: string): Promise<HomeArticle[]> => {
  const result = await dalInstance.query(
    `SELECT slug, title, body, created_at FROM pages
      WHERE _old_rev_of IS NULL AND _rev_deleted = false
        AND ${pageNamespaceSql()} = 'article'
      ORDER BY created_at DESC, slug
      LIMIT $1`,
    [NEW_ARTICLE_COUNT]
  );
  return toHomeArticles(result.rows as ArticleRow[], lang);
};

const loadFeaturedArticle = async (dalInstance: DataAccessLayer, lang: string): Promise<HomeArticle | null> => {
  for (let offset = 0; offset < FEATURED_MAX_SCANNED; offset += FEATURED_BATCH) {
    const result = await dalInstance.query(
      `SELECT slug, title, body, created_at FROM pages
        WHERE _old_rev_of IS NULL AND _rev_deleted = false
          AND ${pageNamespaceSql()} = 'article'
          AND body::text LIKE '%](/media/%'
        ORDER BY created_at DESC, slug
        LIMIT $1 OFFSET $2`,
      [FEATURED_BATCH, offset]
    );
    const rows = result.rows as ArticleRow[];
    const withImage = (await toHomeArticles(rows, lang)).find(article => article.imageSlug);
    if (withImage) return withImage;
    if (rows.length < FEATURED_BATCH) return null;
  }
  return null;
};

const loadPosts = async (): Promise<HomePost[]> => {
  const rows = await BlogPost.filterWhere({})
    .orderBy('createdAt', 'DESC')
    .orderBy('_revDate', 'DESC')
    .limit(BLOG_POST_COUNT)
    .select('slug', 'title', 'createdAt');
  return rows.map(row => ({
    slug: row.slug,
    title: row.title,
    createdAt: row.createdAt,
  }));
};

// Threads with the latest activity: a new thread or a new comment.
const loadThreads = async (dalInstance: DataAccessLayer): Promise<HomeThread[]> => {
  const result = await dalInstance.query(
    `SELECT t.id, t.title, t.category, t.page_slug,
            GREATEST(t.created_at, COALESCE(MAX(c.created_at), t.created_at)) AS last_activity_at
       FROM forum_threads t
       LEFT JOIN forum_comments c
         ON c.thread_id = t.id AND c._old_rev_of IS NULL AND c._rev_deleted = false
      WHERE t._old_rev_of IS NULL AND t._rev_deleted = false
        -- Attached threads are titled with a quote from what they attach to,
        -- not a topic someone chose; they belong on that page, not here.
        AND t.attached_type IS NULL
      GROUP BY t.id
      ORDER BY last_activity_at DESC
      LIMIT $1`,
    [FORUM_THREAD_COUNT]
  );
  return (
    result.rows as Array<{
      id: string;
      title: Record<string, string> | null;
      category: string;
      page_slug: string | null;
      last_activity_at: Date;
    }>
  ).map(row => ({
    id: row.id,
    title: row.title,
    category: row.category,
    pageSlug: row.page_slug,
    lastActivityAt: row.last_activity_at,
  }));
};

// Recently changed proposals that have been opened; drafts are not promoted.
const loadProposals = async (dalInstance: DataAccessLayer): Promise<HomeProposal[]> =>
  (await listProposalPages(dalInstance))
    .filter((item): item is typeof item & { status: ProposalStatus } => item.status !== null && item.status !== 'draft')
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
    .slice(0, PROPOSAL_COUNT)
    .map(item => ({ slug: item.slug, title: item.title, status: item.status }));

const cache = new Map<string, { at: number; sections: HomeSections }>();

/** What the home page shows below the welcome text, in the reader's language where it exists. */
export async function loadHomeSections(
  dalInstance: DataAccessLayer,
  lang: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<HomeSections> {
  const cached = cache.get(lang);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.sections;
  const [articles, featured, posts, threads, proposals, issues] = await Promise.all([
    loadArticles(dalInstance, lang),
    loadFeaturedArticle(dalInstance, lang),
    loadPosts(),
    loadThreads(dalInstance),
    loadProposals(dalInstance),
    countArticlesWithIssues(dalInstance),
  ]);
  const sections = { articles, featured, posts, threads, proposals, issues };
  cache.set(lang, { at: Date.now(), sections });
  return sections;
}
