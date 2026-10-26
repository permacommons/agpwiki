import dal from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { firstSentence } from '../lib/excerpt.js';
import { extractMediaSlugsFromSources } from '../lib/media-render.js';
import { type ArticleIssueKind, countArticlesWithIssues } from './article-issues-service.js';

const { mlString } = dal;

/** The page whose text the home page shows, with these sections below it. */
export const HOME_PAGE_SLUG = 'meta/welcome';

const NEW_ARTICLE_COUNT = 4;
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
  summary: string;
  imageSlug: string | null;
}

export interface HomeThread {
  id: string;
  title: Record<string, string> | null;
  category: string;
  lastActivityAt: Date;
}

export interface HomeSections {
  articles: HomeArticle[];
  posts: HomePost[];
  threads: HomeThread[];
  issues: Record<ArticleIssueKind, number>;
}

const resolveText = (lang: string, value: Record<string, string> | null | undefined) =>
  mlString.resolve(lang, value ?? null)?.str ?? '';

// The first image the text embeds, if it is a known image.
const firstImages = async (dalInstance: DataAccessLayer, sources: Map<string, string>) => {
  const firstBySource = new Map<string, string>();
  for (const [key, source] of sources) {
    const [first] = extractMediaSlugsFromSources([source]);
    if (first) firstBySource.set(key, first);
  }
  const slugs = [...new Set(firstBySource.values())];
  if (!slugs.length) return new Map<string, string>();
  const result = await dalInstance.query(
    `SELECT slug FROM media
      WHERE slug = ANY($1) AND _old_rev_of IS NULL AND _rev_deleted = false
        AND media_type = 'image'`,
    [slugs]
  );
  const known = new Set((result.rows as Array<{ slug: string }>).map(row => row.slug));
  return new Map([...firstBySource].filter(([, slug]) => known.has(slug)));
};

const loadArticles = async (dalInstance: DataAccessLayer, lang: string): Promise<HomeArticle[]> => {
  const result = await dalInstance.query(
    `SELECT slug, title, body, created_at FROM pages
      WHERE _old_rev_of IS NULL AND _rev_deleted = false
        AND slug NOT LIKE 'meta/%' AND slug NOT LIKE 'tool/%'
      ORDER BY created_at DESC, slug
      LIMIT $1`,
    [NEW_ARTICLE_COUNT]
  );
  const rows = result.rows as Array<{
    slug: string;
    title: Record<string, string> | null;
    body: Record<string, string> | null;
    created_at: Date;
  }>;
  const bodies = new Map(rows.map(row => [row.slug, resolveText(lang, row.body)]));
  const images = await firstImages(dalInstance, bodies);
  return rows.map(row => ({
    slug: row.slug,
    title: row.title,
    createdAt: row.created_at,
    excerpt: firstSentence(bodies.get(row.slug)),
    imageSlug: images.get(row.slug) ?? null,
  }));
};

const loadPosts = async (dalInstance: DataAccessLayer, lang: string): Promise<HomePost[]> => {
  const result = await dalInstance.query(
    `SELECT slug, title, summary, body, created_at FROM posts
      WHERE _old_rev_of IS NULL AND _rev_deleted = false
      ORDER BY created_at DESC, _rev_date DESC
      LIMIT $1`,
    [BLOG_POST_COUNT]
  );
  const rows = result.rows as Array<{
    slug: string;
    title: Record<string, string> | null;
    summary: Record<string, string> | null;
    body: Record<string, string> | null;
    created_at: Date;
  }>;
  const bodies = new Map(rows.map(row => [row.slug, resolveText(lang, row.body)]));
  const images = await firstImages(dalInstance, bodies);
  return rows.map(row => ({
    slug: row.slug,
    title: row.title,
    createdAt: row.created_at,
    summary: resolveText(lang, row.summary) || firstSentence(bodies.get(row.slug)),
    imageSlug: images.get(row.slug) ?? null,
  }));
};

// Threads with the latest activity: a new thread or a new comment.
const loadThreads = async (dalInstance: DataAccessLayer): Promise<HomeThread[]> => {
  const result = await dalInstance.query(
    `SELECT t.id, t.title, t.category,
            GREATEST(t.created_at, COALESCE(MAX(c.created_at), t.created_at)) AS last_activity_at
       FROM forum_threads t
       LEFT JOIN forum_comments c
         ON c.thread_id = t.id AND c._old_rev_of IS NULL AND c._rev_deleted = false
      WHERE t._old_rev_of IS NULL AND t._rev_deleted = false
      GROUP BY t.id
      ORDER BY last_activity_at DESC
      LIMIT $1`,
    [FORUM_THREAD_COUNT]
  );
  return (
    result.rows as Array<{ id: string; title: Record<string, string> | null; category: string; last_activity_at: Date }>
  ).map(row => ({
    id: row.id,
    title: row.title,
    category: row.category,
    lastActivityAt: row.last_activity_at,
  }));
};

const cache = new Map<string, { at: number; sections: HomeSections }>();

/** What the home page shows below the welcome text, in the reader's language where it exists. */
export async function loadHomeSections(
  dalInstance: DataAccessLayer,
  lang: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<HomeSections> {
  const cached = cache.get(lang);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.sections;
  const [articles, posts, threads, issues] = await Promise.all([
    loadArticles(dalInstance, lang),
    loadPosts(dalInstance, lang),
    loadThreads(dalInstance),
    countArticlesWithIssues(dalInstance),
  ]);
  const sections = { articles, posts, threads, issues };
  cache.set(lang, { at: Date.now(), sections });
  return sections;
}
