import type { TFunction } from 'i18next';
import dal from 'rev-dal';
import { threadLinkPath } from '../../lib/discussion-paths.js';
import { resolveSafeTextWithFallback } from '../../lib/safe-text.js';
import { escapeHtml, renderText } from '../../render.js';
import { FORUM_CATEGORY_KEYS, type ForumCategorySlug } from '../../services/forum-service.js';
import type { HomeArticle, HomeSections } from '../../services/home-service.js';
import { getSiteBaseUrl } from '../../services/site-config.js';

const { mlString } = dal;

export const NEW_ARTICLES_PATH = '/tool/pages?sort=new';
export const SOURCE_CODE_URL = 'https://github.com/permacommons/agpwiki';

const FEATURED_IMAGE_WIDTH = 500;
const ALSO_NEW_COUNT = 3;
const COMMUNITY_ITEM_COUNT = 3;

const VALUES = [
  { key: 'secular' },
  { key: 'truthSeeking' },
  { key: 'methodical' },
  { key: 'agency' },
  { key: 'accountable' },
] as const;

const pathFor = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;
const mediaFile = (slug: string, width: number) => `/media-files${pathFor(slug)}/${width}`;

const formatDay = (date: Date, locale: string) =>
  date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The big card shows the newest article that has a picture; the others follow
 * as a list. With no picture among the recent articles, the newest one is
 * featured without one.
 */
export const pickNewArticles = (articles: HomeArticle[]) => {
  const featured = articles.find(article => article.imageSlug) ?? articles[0] ?? null;
  const alsoNew = articles.filter(article => article !== featured).slice(0, ALSO_NEW_COUNT);
  return { featured, alsoNew };
};

export const WELCOME_TOOLS_ANCHOR = 'wiki:welcome-tools';

export interface HomePageInput {
  sections: HomeSections;
  articleCount: number;
  /** The rendered text of the welcome page, which editors keep up to date. */
  welcomeHtml: string;
  welcomeLanguage?: string;
  welcomeLanguageRow: string;
  welcomeHistoryHtml: string;
  welcomeDiscussionHref: string | null;
  welcomeFollowHtml: string;
  welcomeFallbackLanguage?: string;
  /** Where to edit the welcome text, for people who may; null otherwise. */
  editHref: string | null;
  signedIn: boolean;
  t: TFunction;
  locale: string;
}

/** The home page: what Agpedia is and stands for, what is new, and the ways in. */
export const renderHomePage = ({
  sections,
  articleCount,
  welcomeHtml,
  welcomeLanguage,
  welcomeLanguageRow,
  welcomeHistoryHtml,
  welcomeDiscussionHref,
  welcomeFollowHtml,
  welcomeFallbackLanguage,
  editHref,
  signedIn,
  t,
  locale,
}: HomePageInput): string => {
  const title = (value: Record<string, string> | null, fallback: string) =>
    renderText(resolveSafeTextWithFallback(mlString.resolve, locale, value, fallback));
  const link = (href: string, label: string, className?: string) =>
    `<a${className ? ` class="${className}"` : ''} href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

  const hero = `<section class="home-hero" aria-labelledby="home-hero-title">
  <div class="home-hero-inner">
    <h2 class="home-hero-title" id="home-hero-title">${escapeHtml(t('home.heroTitle'))}</h2>
    <p class="home-hero-subtitle">${escapeHtml(t('home.heroSubtitle'))}</p>
    <form class="home-search" action="/search" method="get" role="search">
      <label class="visually-hidden" for="home-search-input">${escapeHtml(t('home.searchLabel'))}</label>
      <input class="home-search-input" id="home-search-input" type="search" name="q" placeholder="${escapeHtml(
        t('home.searchPlaceholder', { count: articleCount })
      )}" autocomplete="off">
      <button class="home-search-button" type="submit">${escapeHtml(t('home.searchButton'))}</button>
    </form>
  </div>
  <div class="home-values">
    <div class="home-values-head">
      <h2>${escapeHtml(t('home.valuesTitle'))}</h2>
      <p>${escapeHtml(t('home.valuesIntro'))} <a href="/meta/values">${escapeHtml(t('home.valuesLink'))} <span aria-hidden="true">→</span></a></p>
    </div>
    <ul class="home-values-list">
${VALUES.map(
  value => `      <li><h3>${escapeHtml(t(`home.values.${value.key}Name`))}</h3><p>${escapeHtml(t(`home.values.${value.key}`))}</p></li>`
).join('\n')}
    </ul>
  </div>
</section>`;

  const { featured, alsoNew } = pickNewArticles(sections.articles);
  const featuredHtml = featured
    ? `<a class="home-featured" href="${escapeHtml(pathFor(featured.slug))}">
    ${
      featured.imageSlug
        ? `<img class="home-featured-image" src="${escapeHtml(mediaFile(featured.imageSlug, FEATURED_IMAGE_WIDTH))}" alt="" loading="lazy">`
        : ''
    }
    <span class="home-featured-text">
      <span class="home-featured-title">${title(featured.title, featured.slug)}</span>
      ${featured.excerpt ? `<span class="home-featured-excerpt">${escapeHtml(featured.excerpt)}</span>` : ''}
      <span class="home-meta">${escapeHtml(formatDay(featured.createdAt, locale))}</span>
    </span>
  </a>`
    : `<p class="home-empty">${escapeHtml(t('home.noArticles'))}</p>`;
  const alsoNewHtml = alsoNew.length
    ? `<div class="home-also-new">
    <h3 class="home-kicker">${escapeHtml(t('home.alsoNew'))}</h3>
    <ul class="home-list">
${alsoNew
  .map(
    article => `      <li><a href="${escapeHtml(pathFor(article.slug))}"><span class="home-list-title">${title(
      article.title,
      article.slug
    )}</span>${article.excerpt ? `<span class="home-list-text">${escapeHtml(article.excerpt)}</span>` : ''}</a></li>`
  )
  .join('\n')}
    </ul>
    ${link(NEW_ARTICLES_PATH, t('home.allNewArticles'), 'home-more')}
  </div>`
    : '';
  const newArticles = `<section class="home-section home-new" aria-labelledby="home-new-title">
  <h2 class="home-kicker" id="home-new-title">${escapeHtml(t('home.newArticles'))}</h2>
  <div class="home-new-grid">
  ${featuredHtml}
  ${alsoNewHtml}
  </div>
</section>`;

  const how = `<section class="home-section home-how" aria-labelledby="home-how-title">
  <h2 id="home-how-title">${escapeHtml(t('home.howTitle'))}</h2>
  <div class="home-how-body">
    <div class="home-welcome-markdown"${welcomeLanguage ? ` lang="${escapeHtml(welcomeLanguage)}"` : ''} dir="auto">${welcomeHtml}</div>
    ${welcomeFallbackLanguage ? `<p class="home-welcome-language">${escapeHtml(t('home.welcomeFallbackLanguage', { language: welcomeFallbackLanguage }))}</p>` : ''}
    <details class="home-welcome-details">
      <summary>${escapeHtml(t('home.welcomeDetails'))}</summary>
      <div class="home-welcome-panel" id="${WELCOME_TOOLS_ANCHOR}">
        ${welcomeLanguageRow}
        <div class="home-welcome-actions">
          ${welcomeDiscussionHref ? link(welcomeDiscussionHref, t('forum.discussThisPage'), 'home-welcome-action') : ''}
          ${editHref ? link(editHref, t('home.editWelcome'), 'home-welcome-action') : ''}
          ${welcomeFollowHtml}
        </div>
        ${welcomeHistoryHtml}
      </div>
    </details>
  </div>
</section>`;

  const card = (
    variant: string,
    label: string,
    heading: string,
    text: string,
    links: string[],
    { extra = '', footer = '' }: { extra?: string; footer?: string } = {}
  ) =>
    `<div class="home-way home-way--${variant}">
    <p class="home-way-label">${escapeHtml(label)}</p>
    <h3>${escapeHtml(heading)}</h3>
    <p>${escapeHtml(text)}</p>
    ${extra}
    <p class="home-way-links">${links.join('')}</p>
    ${footer}
  </div>`;
  const ways = `<section class="home-section home-ways" aria-labelledby="home-ways-title">
  <h2 id="home-ways-title">${escapeHtml(t('home.waysTitle'))}</h2>
  <div class="home-ways-grid">
  ${card('read', t('home.readLabel'), t('home.readTitle'), t('home.readText'), [
    link('/tool/pages', t('home.readAll')),
    link(NEW_ARTICLES_PATH, t('home.readNew')),
  ])}
  ${card('help', t('home.helpLabel'), t('home.helpTitle'), t('home.helpText'), [
    signedIn ? '' : link('/tool/create-account', t('home.createAccount'), 'home-way-button'),
    link('/meta/wishlist', t('home.wishlist')),
    link('/tool/issues?kind=unchecked', t('home.waitingForCheck', { count: sections.issues.unchecked })),
  ])}
  ${card(
    'agent',
    t('home.agentLabel'),
    t('home.agentTitle'),
    t('home.agentText'),
    [link('/meta/setup', t('home.agentSetup')), link('/meta/mcp-reference', t('home.agentReference'))],
    {
      extra: `<code class="home-endpoint">${escapeHtml(`${getSiteBaseUrl()}/mcp`)}</code>`,
      footer: `<p class="home-code">${escapeHtml(t('home.codeLine'))} ${link(SOURCE_CODE_URL, t('home.codeLink'))}</p>`,
    }
  )}
  </div>
</section>`;

  const column = (heading: string, href: string, more: string, items: string, empty: string) =>
    `<div class="home-column">
    <div class="home-column-head"><h3>${escapeHtml(heading)}</h3>${link(href, more)}</div>
    ${items || `<p class="home-empty">${escapeHtml(empty)}</p>`}
  </div>`;
  const listOf = (rows: Array<{ href: string; titleHtml: string; meta: string }>) =>
    rows.length
      ? `<ul class="home-list">${rows
          .map(
            row =>
              `<li><a href="${escapeHtml(row.href)}"><span class="home-list-title">${row.titleHtml}</span><span class="home-meta">${escapeHtml(row.meta)}</span></a></li>`
          )
          .join('')}</ul>`
      : '';
  const threads = listOf(
    sections.threads.slice(0, COMMUNITY_ITEM_COUNT).map(thread => {
      const categoryKey = FORUM_CATEGORY_KEYS[thread.category as ForumCategorySlug];
      return {
        href: threadLinkPath(thread),
        titleHtml: title(thread.title, ''),
        meta: `${categoryKey ? t(categoryKey) : thread.category} · ${formatDay(thread.lastActivityAt, locale)}`,
      };
    })
  );
  const proposals = listOf(
    sections.proposals.slice(0, COMMUNITY_ITEM_COUNT).map(proposal => ({
      href: pathFor(proposal.slug),
      titleHtml: title(proposal.title, proposal.slug),
      meta: t(`proposalStatus.status.${proposal.status}`),
    }))
  );
  const posts = listOf(
    sections.posts.slice(0, COMMUNITY_ITEM_COUNT).map(post => ({
      href: `/blog${pathFor(post.slug)}`,
      titleHtml: title(post.title, post.slug),
      meta: formatDay(post.createdAt, locale),
    }))
  );
  const community = `<section class="home-section home-community" aria-labelledby="home-community-title">
  <h2 id="home-community-title">${escapeHtml(t('home.communityTitle'))}</h2>
  <div class="home-community-grid">
  ${column(t('home.forumTitle'), '/tool/forum', t('home.openForum'), threads, t('home.noThreads'))}
  ${column(t('home.proposalsTitle'), '/tool/proposals', t('home.allProposals'), proposals, t('home.noProposals'))}
  ${column(t('home.blogTitle'), '/blog', t('home.allPosts'), posts, t('home.noPosts'))}
  </div>
</section>`;

  return `${hero}
<div class="home-body">
${newArticles}
${how}
${ways}
${community}
</div>`;
};
