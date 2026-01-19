import fs from 'node:fs';
import path from 'node:path';
import { Driver } from '@citeproc-rs/wasm';
import { diffWordsWithSpace } from 'diff';
import hbs from 'hbs';
import MarkdownIt from 'markdown-it';

import citationsPlugin from './markdown/citations.js';
import { variablesPlugin } from './markdown/variables.js';
import { getArticleCount } from './metrics.js';

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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

        rendered.push(`-${oldHtml}`);
        rendered.push(`+${newHtml}`);
        i += 1;
        continue;
      }
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

const buildCiteproc = (references: Array<Record<string, unknown>>) => {
  const driver = new Driver({
    style: citationStyle,
    format: 'html',
    bibliographyNoSort: true,
  });

  driver.insertReferences(references);

  const clusters: CiteprocCluster[] = [];
  const clusterMap = new Map<string, string[]>();
  const refOrder: string[] = [];
  const refNumberById = new Map<string, number>();
  const refBacklinks = new Map<string, string[]>();
  let renderCache: ReturnType<Driver['fullRender']> | null = null;
  let noteCounter = 0;

  const ensureRender = () => {
    if (renderCache) return renderCache;
    driver.setClusterOrder(clusters);
    renderCache = driver.fullRender();
    return renderCache;
  };

  return {
    appendCluster(cluster: Array<{ citationId: string }>) {
      const id = `cluster-${noteCounter + 1}`;
      noteCounter += 1;
      const citationIds = cluster.map(cite => cite.citationId);
      clusterMap.set(id, citationIds);
      clusters.push({ id, note: noteCounter });
      driver.insertCluster({
        id,
        cites: citationIds.map(citeId => ({ id: citeId })),
      });
      return id;
    },
    renderCluster(id: string) {
      const citationIds = clusterMap.get(id) ?? [];
      if (citationIds.length === 0) return '';

      const parts = citationIds.map(citationId => {
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
        backlinkList.push(anchorId);
        refBacklinks.set(citationId, backlinkList);
        return `<sup class="citation-ref" id="${anchorId}">[<a href="#ref-${refNumber}">${refNumber}</a>]</sup>`;
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
          let backlinks = '';
          if (anchors.length === 1) {
            backlinks = `<a class="ref-backlink" href="#${anchors[0]}" aria-label="Back to citation">^</a>`;
          } else if (anchors.length > 1) {
            backlinks = anchors
              .map((anchorId, backlinkIndex) => {
                const suffix = toBacklinkSuffix(backlinkIndex);
                return `<a class="ref-backlink" href="#${anchorId}" aria-label="Back to citation">^${suffix}</a>`;
              })
              .join(' ');
          }
          const backlinkHtml = backlinks ? `<span class="ref-backlinks">${backlinks}</span> ` : '';
          return `<li id="ref-${refNumber}">${backlinkHtml}${entry}</li>`;
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

export const renderMarkdown = async (
  bodySource: string,
  citationEntries: Array<Record<string, unknown>>
) => {
  const env: Record<string, unknown> = { variables: {} };
  if (citationEntries.length > 0) {
    env.citeprocFactory = () => buildCiteproc(citationEntries);
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
  return html;
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
  title: string;
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
  return layoutTemplate({
    title,
    bodyHtml,
    labelHtml,
    sidebarHtml,
    topHtml,
    hasSidebar: Boolean(sidebarHtml),
    signedIn: Boolean(signedIn),
    locale,
    languageOptions,
  });
};
