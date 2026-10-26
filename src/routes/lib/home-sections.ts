import type { TFunction } from 'i18next';
import dal from 'rev-dal';
import { forumThreadPath } from '../../lib/forum-paths.js';
import { resolveSafeTextWithFallback } from '../../lib/safe-text.js';
import { escapeHtml, renderText } from '../../render.js';
import { FORUM_CATEGORY_KEYS, type ForumCategorySlug } from '../../services/forum-service.js';
import type { HomeSections } from '../../services/home-service.js';

const { mlString } = dal;

export const NEW_ARTICLES_PATH = '/tool/pages?sort=new';

const ARTICLE_THUMB_WIDTH = 250;
const POST_IMAGE_WIDTH = 500;

const pathFor = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;
const mediaFile = (slug: string, width: number) => `/media-files${pathFor(slug)}/${width}`;

const formatDay = (date: Date, locale: string) =>
  date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

// The button sits beside the heading on wide screens and under the section on phones.
const section = (name: string, heading: string, href: string, label: string, body: string) => {
  const button = `<a class="home-button" href="${escapeHtml(href)}">${escapeHtml(label)} <span aria-hidden="true">→</span></a>`;
  return `<section class="home-section home-section--${name}" aria-labelledby="home-${name}">
  <div class="home-section-head"><h2 id="home-${name}">${escapeHtml(heading)}</h2><span class="home-head-button">${button}</span></div>
  ${body}
  <div class="home-foot-button">${button}</div>
</section>`;
};

/** New articles, blog posts, forum discussions and ways to help, shown below the welcome text. */
export const renderHomeSections = (sections: HomeSections, t: TFunction, locale: string): string => {
  const title = (value: Record<string, string> | null, fallback: string) =>
    renderText(resolveSafeTextWithFallback(mlString.resolve, locale, value, fallback));

  const articles = sections.articles.length
    ? `<div class="home-cards">${sections.articles
        .map(
          article => `<a class="home-card" href="${escapeHtml(pathFor(article.slug))}">
    <span class="home-kicker">${escapeHtml(t('home.newArticleLabel'))} · ${escapeHtml(formatDay(article.createdAt, locale))}</span>
    <span class="home-card-row"><span class="home-card-title">${title(article.title, article.slug)}</span>${
      article.imageSlug
        ? `<img class="home-thumb" src="${escapeHtml(mediaFile(article.imageSlug, ARTICLE_THUMB_WIDTH))}" alt="" loading="lazy">`
        : ''
    }</span>
    ${article.excerpt ? `<span class="home-card-text">${escapeHtml(article.excerpt)}</span>` : ''}
  </a>`
        )
        .join('')}</div>`
    : `<p class="home-empty">${escapeHtml(t('home.noArticles'))}</p>`;

  const posts = sections.posts.length
    ? `<div class="home-posts">${sections.posts
        .map(
          post => `<a class="home-post" href="${escapeHtml(`/blog${pathFor(post.slug)}`)}">
    ${
      post.imageSlug
        ? `<img class="home-post-image" src="${escapeHtml(mediaFile(post.imageSlug, POST_IMAGE_WIDTH))}" alt="" loading="lazy">`
        : ''
    }
    <span class="home-kicker">${escapeHtml(t('home.blogLabel'))} · ${escapeHtml(formatDay(post.createdAt, locale))}</span>
    <span class="home-card-title">${title(post.title, post.slug)}</span>
    ${post.summary ? `<span class="home-card-text home-card-text--short">${escapeHtml(post.summary)}</span>` : ''}
  </a>`
        )
        .join('')}</div>`
    : `<p class="home-empty">${escapeHtml(t('home.noPosts'))}</p>`;

  const threads = sections.threads.length
    ? `<ul class="home-threads">${sections.threads
        .map(thread => {
          const categoryKey = FORUM_CATEGORY_KEYS[thread.category as ForumCategorySlug];
          const category = categoryKey ? t(categoryKey) : thread.category;
          return `<li><a href="${escapeHtml(forumThreadPath(thread.id))}">
    <span class="home-thread-title">${title(thread.title, '')}</span>
    <span class="home-thread-meta">${escapeHtml(category)} · ${escapeHtml(formatDay(thread.lastActivityAt, locale))}</span>
  </a></li>`;
        })
        .join('')}</ul>`
    : `<p class="home-empty">${escapeHtml(t('home.noThreads'))}</p>`;

  const help = [
    `<a href="/tool/issues?kind=unchecked">${escapeHtml(t('home.waitingForCheck', { count: sections.issues.unchecked }))}</a>`,
    `<a href="/tool/issues?kind=no-wikidata">${escapeHtml(t('home.needWikidata', { count: sections.issues['no-wikidata'] }))}</a>`,
    `<a href="/meta/help">${escapeHtml(t('home.howToContribute'))}</a>`,
  ].join(' · ');

  return `<div class="home-sections">
${section('articles', t('home.newArticles'), NEW_ARTICLES_PATH, t('home.seeMoreArticles'), articles)}
${section('blog', t('home.fromBlog'), '/blog', t('home.seeAllPosts'), posts)}
${section('forum', t('home.inForum'), '/tool/forum', t('home.goToForum'), threads)}
<p class="home-help"><strong>${escapeHtml(t('home.waysToHelp'))}</strong> ${help}</p>
</div>`;
};
