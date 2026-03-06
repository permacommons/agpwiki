import fs from 'node:fs';
import path from 'node:path';
import { Driver } from '@citeproc-rs/wasm';
import { diffWordsWithSpace } from 'diff';
import hbs from 'hbs';
import MarkdownIt from 'markdown-it';

import { layoutAssets } from './asset-urls.js';
import citationsPlugin from './markdown/citations.js';
import { type TocItem, tocPlugin } from './markdown/toc.js';
import { variablesPlugin } from './markdown/variables.js';
import { getArticleCount } from './metrics.js';

export { renderToc, type TocItem } from './markdown/toc.js';

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * SafeText represents HTML-safe text. It may include HTML entities or special
 * characters, but it must not contain HTML tags.
 * It should be rendered without additional escaping to avoid double-encoding
 * when entities are already encoded.
 */
export type SafeText = { __safeText: true; value: string };

/**
 * Wrap a string that is HTML-safe (no tags; may include entities or special characters).
 */
export const toSafeText = (value: string): SafeText => ({
  __safeText: true,
  value,
});

export const isSafeText = (value: unknown): value is SafeText =>
  typeof value === 'object' && value !== null && (value as SafeText).__safeText === true;

/**
 * Render SafeText without escaping (entities, if present, remain as-is).
 */
export const renderSafeText = (value: SafeText) => value.value;

/**
 * Render any text as HTML-safe, escaping only when needed.
 */
export const renderText = (value: SafeText | string) =>
  isSafeText(value) ? renderSafeText(value) : escapeHtml(value);

export const concatSafeText = (...parts: Array<SafeText | string>) =>
  toSafeText(parts.map(part => renderText(part)).join(''));

export const formatDateUTC = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' });
};

export const normalizeForDiff = (value: string) => (value.endsWith('\n') ? value : `${value}\n`);

export const renderUnifiedDiff = (diffText: string) => {
  const lines = diffText.split('\n');
  const rendered: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isOld = line.startsWith('-') && !line.startsWith('---');
    const isAdded = line.startsWith('+') && !line.startsWith('+++');

    if (isOld && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const nextIsNew = nextLine.startsWith('+') && !nextLine.startsWith('+++');
      if (nextIsNew) {
        const oldContent = line.slice(1);
        const newContent = nextLine.slice(1);
        const wordDiff = diffWordsWithSpace(oldContent, newContent);

        const oldHtml = wordDiff
          .map(part => {
            const value = escapeHtml(part.value);
            if (part.added) return '';
            if (part.removed) return `<del>${value}</del>`;
            return value;
          })
          .join('');

        const newHtml = wordDiff
          .map(part => {
            const value = escapeHtml(part.value);
            if (part.removed) return '';
            if (part.added) return `<ins>${value}</ins>`;
            return value;
          })
          .join('');

        rendered.push(
          `<span class="diff-line removed"><span class="diff-sign">-</span><span class="diff-text">${oldHtml}</span></span>`
        );
        rendered.push(
          `<span class="diff-line added"><span class="diff-sign">+</span><span class="diff-text">${newHtml}</span></span>`
        );
        i += 1;
        continue;
      }
    }

    if (isOld) {
      rendered.push(
        `<span class="diff-line removed"><span class="diff-sign">-</span><span class="diff-text">${escapeHtml(
          line.slice(1)
        )}</span></span>`
      );
      continue;
    }

    if (isAdded) {
      rendered.push(
        `<span class="diff-line added"><span class="diff-sign">+</span><span class="diff-text">${escapeHtml(
          line.slice(1)
        )}</span></span>`
      );
      continue;
    }

    rendered.push(escapeHtml(line));
  }

  return rendered.join('\n');
};

type CiteprocCluster = { id: string; note: number };

const citationStylePath = path.resolve(process.cwd(), 'vendor/csl/agpwiki-author-date.csl');
const citationStyle = fs.readFileSync(citationStylePath, 'utf8');
const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.use(variablesPlugin());
markdown.use(tocPlugin());

type TableRenderContext = {
  headerLabels: string[];
  stackOnMobile: boolean;
  cellIndex: number;
};

const MAX_STACK_COLUMNS = 3;
const normalizeLabel = (value: string) => value.replace(/\s+/g, ' ').trim();

// Extracts first-header-row labels so we can annotate body cells with
// data-label attributes for CSS-only mobile card rendering.
const getInlineTextUntilClose = (
  tokens: MarkdownIt.Token[],
  startIdx: number,
  closeType: string
): { text: string; nextIdx: number } => {
  let text = '';
  let depth = 1;
  let idx = startIdx;
  const openType = closeType.replace('_close', '_open');

  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token.type === closeType) {
      depth -= 1;
      if (depth === 0) break;
    } else if (token.type === openType) {
      depth += 1;
    } else if (token.type === 'inline') {
      text += token.content;
    }
    idx += 1;
  }

  return { text: normalizeLabel(text), nextIdx: idx };
};

const getTableHeaderLabels = (tokens: MarkdownIt.Token[], tableOpenIdx: number): string[] => {
  const labels: string[] = [];
  let idx = tableOpenIdx + 1;
  let inThead = false;
  let headRowIndex = -1;

  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token.type === 'table_close') break;
    if (token.type === 'thead_open') {
      inThead = true;
      idx += 1;
      continue;
    }
    if (token.type === 'thead_close') break;
    if (!inThead) {
      idx += 1;
      continue;
    }
    if (token.type === 'tr_open') {
      headRowIndex += 1;
      idx += 1;
      continue;
    }
    if (token.type === 'tr_close' || headRowIndex > 0) {
      idx += 1;
      continue;
    }
    if (token.type === 'th_open') {
      const { text, nextIdx } = getInlineTextUntilClose(tokens, idx + 1, 'th_close');
      labels.push(text);
      idx = nextIdx + 1;
      continue;
    }
    idx += 1;
  }

  return labels;
};

type RuleName = 'table_open' | 'table_close' | 'tr_open' | 'td_open';
const getRuleOrDefault = (name: RuleName) =>
  markdown.renderer.rules[name] ??
  ((tokens: MarkdownIt.Token[], idx: number, options: MarkdownIt.Options, _env: unknown, self: MarkdownIt.Renderer) =>
    self.renderToken(tokens, idx, options));

const defaultTableOpen = getRuleOrDefault('table_open');
const defaultTableClose = getRuleOrDefault('table_close');
const defaultTrOpen = getRuleOrDefault('tr_open');
const defaultTdOpen = getRuleOrDefault('td_open');

// Tracks per-table header labels while markdown-it streams tokens so we can:
// 1) add wrapper classes based on column count and
// 2) map each <td> to its column label without client-side JavaScript.
const tableRenderContexts: TableRenderContext[] = [];

markdown.renderer.rules.table_open = (tokens, idx, options, env, self) => {
  const headerLabels = getTableHeaderLabels(tokens, idx);
  // Small tables are much more readable as stacked cards on narrow screens.
  const stackOnMobile = headerLabels.length > 0 && headerLabels.length <= MAX_STACK_COLUMNS;
  tableRenderContexts.push({
    headerLabels,
    stackOnMobile,
    cellIndex: 0,
  });
  const wrapperClass = stackOnMobile ? 'table-scroll table-stack-mobile' : 'table-scroll';
  return `<div class="${wrapperClass}">${defaultTableOpen(tokens, idx, options, env, self)}`;
};
markdown.renderer.rules.table_close = (tokens, idx, options, env, self) => {
  tableRenderContexts.pop();
  return `${defaultTableClose(tokens, idx, options, env, self)}</div>`;
};
markdown.renderer.rules.tr_open = (tokens, idx, options, env, self) => {
  const current = tableRenderContexts.at(-1);
  if (current) current.cellIndex = 0;
  return defaultTrOpen(tokens, idx, options, env, self);
};
markdown.renderer.rules.td_open = (tokens, idx, options, env, self) => {
  const current = tableRenderContexts.at(-1);
  if (current?.stackOnMobile) {
    const label = current.headerLabels[current.cellIndex];
    if (label) {
      tokens[idx].attrSet('data-label', label);
    }
    current.cellIndex += 1;
  }
  return defaultTdOpen(tokens, idx, options, env, self);
};

const toBacklinkSuffix = (index: number) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let value = index;
  let suffix = '';
  do {
    suffix = alphabet[value % 26] + suffix;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return suffix;
};

type CitationClusterItem = { citationId: string; claimId?: string };
type BacklinkEntry = {
  anchorId: string;
  claimId?: string;
  targetId?: string;
  claimSlot?: number;
};

const buildCiteproc = (
  references: Array<Record<string, unknown>>,
  backToCitationLabel: string
) => {
  const driver = new Driver({
    style: citationStyle,
    format: 'html',
    bibliographyNoSort: true,
  });

  driver.insertReferences(references);

  const clusters: CiteprocCluster[] = [];
  const clusterMap = new Map<string, CitationClusterItem[]>();
  const refOrder: string[] = [];
  const refNumberById = new Map<string, number>();
  const refBacklinks = new Map<string, BacklinkEntry[]>();
  const citationClaimSlots = new Map<string, Map<string, number>>();
  let renderCache: ReturnType<Driver['fullRender']> | null = null;
  let noteCounter = 0;
  let claimSuffixesReady = false;
  const escapedBackToCitationLabel = escapeHtml(backToCitationLabel);

  const ensureRender = () => {
    if (renderCache) return renderCache;
    driver.setClusterOrder(clusters);
    renderCache = driver.fullRender();
    return renderCache;
  };

  const normalizeClaimId = (claimId: string | undefined) => {
    const normalized = claimId?.trim();
    return normalized ? normalized : undefined;
  };

  const ensureClaimSlots = () => {
    if (claimSuffixesReady) return;
    claimSuffixesReady = true;
    const claimIdsByCitation = new Map<string, string[]>();

    for (const { id } of clusters) {
      const cluster = clusterMap.get(id) ?? [];
      for (const cite of cluster) {
        const claimId = normalizeClaimId(cite.claimId);
        if (!claimId) continue;
        if (!claimIdsByCitation.has(cite.citationId)) {
          claimIdsByCitation.set(cite.citationId, []);
        }
        const claimIds = claimIdsByCitation.get(cite.citationId);
        if (claimIds && !claimIds.includes(claimId)) {
          claimIds.push(claimId);
        }
      }
    }

    // Slots are per-citation and stable by first-seen claim order in the rendered doc.
    // This keeps in-text labels deterministic: 12:1 always means the same claim.
    for (const [citationId, claimIds] of claimIdsByCitation.entries()) {
      const slots = new Map<string, number>();
      for (const [index, claimId] of claimIds.entries()) {
        slots.set(claimId, index + 1);
      }
      citationClaimSlots.set(citationId, slots);
    }
  };

  return {
    appendCluster(cluster: CitationClusterItem[]) {
      const id = `cluster-${noteCounter + 1}`;
      noteCounter += 1;
      const citationIds = cluster.map(cite => cite.citationId);
      clusterMap.set(id, cluster);
      clusters.push({ id, note: noteCounter });
      driver.insertCluster({
        id,
        cites: citationIds.map(citeId => ({ id: citeId })),
      });
      return id;
    },
    renderCluster(id: string) {
      ensureClaimSlots();
      const cluster = clusterMap.get(id) ?? [];
      if (cluster.length === 0) return '';

      const parts = cluster.map(({ citationId, claimId }) => {
        let refNumber = refNumberById.get(citationId);
        if (!refNumber) {
          refNumber = refOrder.length + 1;
          refOrder.push(citationId);
          refNumberById.set(citationId, refNumber);
        }
        const backlinkList = refBacklinks.get(citationId) ?? [];
        const backlinkIndex = backlinkList.length;
        const suffix = toBacklinkSuffix(backlinkIndex);
        const anchorId = `cite-ref-${refNumber}-${suffix}`;
        const normalizedClaimId = normalizeClaimId(claimId);
        const claimSlots = citationClaimSlots.get(citationId);
        const claimSlot = normalizedClaimId ? claimSlots?.get(normalizedClaimId) : undefined;
        const refLabel = claimSlot ? `${refNumber}:${claimSlot}` : `${refNumber}`;
        // Claim-specific refs target claim anchors; plain refs keep the legacy #ref-N target.
        const targetId = claimSlot ? `ref-${refNumber}-${claimSlot}` : undefined;
        backlinkList.push({ anchorId, claimId: normalizedClaimId, targetId, claimSlot });
        refBacklinks.set(citationId, backlinkList);
        const targetHref = targetId ? `#${targetId}` : `#ref-${refNumber}`;
        return `<sup class="citation-ref" id="${anchorId}">[<a href="${targetHref}">${refLabel}</a>]</sup>`;
      });

      return `<span class="citation-group">${parts.join('')}</span>`;
    },
    renderBibliography() {
      const render = ensureRender();
      const entryMap = new Map(render.bibEntries.map(entry => [entry.id, entry.value]));
      const items = refOrder
        .map((citationId, index) => {
          const refNumber = index + 1;
          const entry = entryMap.get(citationId);
          if (!entry) return '';
          const anchors = refBacklinks.get(citationId) ?? [];
          let linkPairs = '';
          if (anchors.length > 0) {
            const claimGroups = new Map<
              string,
              { claimId: string; claimSlot: number; targetId: string; anchorIds: string[] }
            >();
            const nonClaimAnchors: string[] = [];

            for (const entry of anchors) {
              const claimId = entry.claimId?.trim();
              if (claimId && entry.claimSlot && entry.targetId) {
                const key = `${entry.claimSlot}:${claimId}`;
                if (!claimGroups.has(key)) {
                  claimGroups.set(key, {
                    claimId,
                    claimSlot: entry.claimSlot,
                    targetId: entry.targetId,
                    anchorIds: [],
                  });
                }
                claimGroups.get(key)?.anchorIds.push(entry.anchorId);
              } else {
                nonClaimAnchors.push(entry.anchorId);
              }
            }

            // Deduplicate by claim slot: repeated cites to the same claim share one
            // bibliography target and collect multiple backlinks (^a, ^b, ...).
            const claimGroupHtml = Array.from(claimGroups.values())
              .sort((a, b) => a.claimSlot - b.claimSlot)
              .map(group => {
                const backlinks = group.anchorIds
                  .map((anchorId, backlinkIndex) => {
                    const suffix = toBacklinkSuffix(backlinkIndex);
                    const backlinkLabel = group.anchorIds.length === 1 ? '^' : `^${suffix}`;
                    return `<a class="ref-backlink" href="#${anchorId}" aria-label="${escapedBackToCitationLabel}">${backlinkLabel}</a>`;
                  })
                  .join(' ');
                const claimLink = `<a class="ref-claim-link" href="/cite/${encodeURIComponent(
                  citationId
                )}#claim-${encodeURIComponent(group.claimId)}">↗ ${escapeHtml(group.claimId)}</a>`;
                return `<span id="${group.targetId}" class="ref-claim-pair">${backlinks} ${claimLink}</span>`;
              });

            const nonClaimHtml =
              nonClaimAnchors.length > 0
                ? `<span class="ref-claim-pair">${nonClaimAnchors
                    .map((anchorId, backlinkIndex) => {
                      const suffix = toBacklinkSuffix(backlinkIndex);
                      const backlinkLabel =
                        nonClaimAnchors.length === 1 ? '^' : `^${suffix}`;
                      return `<a class="ref-backlink" href="#${anchorId}" aria-label="${escapedBackToCitationLabel}">${backlinkLabel}</a>`;
                    })
                    .join(' ')}</span>`
                : '';

            linkPairs = [...claimGroupHtml, nonClaimHtml].filter(Boolean).join(' ');
          }
          const linkHtml = linkPairs ? `<span class="ref-claim-pairs">${linkPairs}</span> ` : '';
          return `<li id="ref-${refNumber}">${linkHtml}${entry}</li>`;
        })
        .filter(Boolean)
        .join('\n');
      if (!items) return '';
      return `<ol class="citation-notes">${items}</ol>`;
    },
    free() {
      driver.free();
    },
  };
};

markdown.use(citationsPlugin, {
  citeproc: env => {
    const citeproc = env.citeprocFactory?.() ?? env.citeprocInstance;
    if (citeproc) {
      env.citeprocInstance = citeproc;
      return citeproc;
    }
    return {
      appendCluster: () => '',
      renderCluster: () => '',
      renderBibliography: () => '',
    };
  },
});

export type RenderResult = {
  html: string;
  toc: TocItem[];
};

export type RenderMarkdownOptions = {
  backToCitationLabel?: string;
};

export const renderMarkdown = async (
  bodySource: string,
  citationEntries: Array<Record<string, unknown>>,
  options: RenderMarkdownOptions = {}
): Promise<RenderResult> => {
  const backToCitationLabel = options.backToCitationLabel ?? 'Back to citation';
  const env: Record<string, unknown> = { variables: {}, toc: [], tocSlugs: new Set() };
  if (citationEntries.length > 0) {
    env.citeprocFactory = () => buildCiteproc(citationEntries, backToCitationLabel);
  }

  if (bodySource.includes('{{article_count}}')) {
    const count = await getArticleCount();
    (env.variables as Record<string, string>).article_count = String(count);
  }

  const html = markdown.render(bodySource, env);
  const citeprocInstance = env.citeprocInstance as { free?: () => void } | undefined;
  if (typeof citeprocInstance?.free === 'function') {
    citeprocInstance.free();
  }
  const toc = (env.toc ?? []) as TocItem[];
  return { html, toc };
};

const { handlebars: Handlebars } = hbs;
const layoutPath = path.resolve(process.cwd(), 'views/layout.hbs');
const layoutTemplate = Handlebars.compile(fs.readFileSync(layoutPath, 'utf8'));

Handlebars.registerPartial(
  'header',
  fs.readFileSync(path.resolve(process.cwd(), 'views/partials/header.hbs'), 'utf8')
);
Handlebars.registerPartial(
  'footer',
  fs.readFileSync(path.resolve(process.cwd(), 'views/partials/footer.hbs'), 'utf8')
);

Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);

export interface LanguageOption {
  code: string;
  label: string;
}

export const renderLayout = (options: {
  title: SafeText | string;
  bodyHtml: string;
  labelHtml?: string;
  sidebarHtml?: string;
  topHtml?: string;
  signedIn?: boolean;
  locale?: string;
  languageOptions?: LanguageOption[];
}) => {
  const {
    title,
    bodyHtml,
    labelHtml = '',
    sidebarHtml = '',
    topHtml = '',
    signedIn,
    locale = 'en',
    languageOptions = [],
  } = options;
  const titleHtml = renderText(title);
  const safeTitle = new hbs.handlebars.SafeString(titleHtml);
  return layoutTemplate({
    title: safeTitle,
    bodyHtml,
    labelHtml,
    sidebarHtml,
    topHtml,
    hasSidebar: Boolean(sidebarHtml),
    signedIn: Boolean(signedIn),
    locale,
    languageOptions,
    assets: layoutAssets,
  });
};
