import { chromium } from 'playwright';

export interface WebFetchInput {
  url: string;
  waitMs?: number;
  timeoutMs?: number;
  maxChars?: number;
  includeHtml?: boolean;
  headless?: boolean;
  slowMoMs?: number;
  holdOpenMs?: number;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  title: string | null;
  text: string;
  html?: string;
  meta: Record<string, string>;
  fetchedAt: string;
  truncated: boolean;
}

const truncate = (value: string, maxChars: number) => {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
};

export async function fetchWebPage({
  url,
  waitMs = 0,
  timeoutMs = 15000,
  maxChars = 40000,
  includeHtml = false,
  headless = true,
  slowMoMs,
  holdOpenMs = 0,
}: WebFetchInput): Promise<WebFetchResult> {
  const browser = await chromium.launch({
    headless,
    slowMo: slowMoMs,
  });
  const page = await browser.newPage();

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) {
      throw new Error(`No response received for ${url}`);
    }

    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }
    if (holdOpenMs > 0) {
      await page.waitForTimeout(holdOpenMs);
    }

    const metadata = (await page.evaluate(`
      (() => {
        const meta = {};
        const get = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return '';
          return element.getAttribute('content') || element.getAttribute('href') || '';
        };
        const setIf = (key, value) => {
          if (value) meta[key] = value;
        };
        setIf('description', get('meta[name="description"]'));
        setIf('author', get('meta[name="author"]'));
        setIf('publishedTime', get('meta[property="article:published_time"]'));
        setIf('siteName', get('meta[property="og:site_name"]'));
        setIf('canonical', get('link[rel="canonical"]'));
        setIf('ogTitle', get('meta[property="og:title"]'));
        setIf('ogUrl', get('meta[property="og:url"]'));
        return meta;
      })()
    `)) as Record<string, string>;

    const title = await page.title();
    const rawText = (await page.evaluate(`(() => document.body?.innerText || '')()`)) as string;
    const rawHtml = includeHtml ? await page.content() : '';

    const { value: text, truncated: textTruncated } = truncate(rawText, maxChars);
    const html = includeHtml ? truncate(rawHtml, maxChars).value : undefined;

    return {
      url,
      finalUrl: page.url(),
      title: title || null,
      text,
      html,
      meta: metadata,
      fetchedAt: new Date().toISOString(),
      truncated: textTruncated || (includeHtml && rawHtml.length > maxChars),
    };
  } finally {
    await page.close();
    await browser.close();
  }
}
