// Rendering and recipient extraction must agree on which text belongs to URLs.
export const splitEscapedTextUrls = (text: string) => {
  const parts: Array<{ text: string; isUrl: boolean }> = [];
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<]+/g)) {
    const url = match[0];
    const trailing = /(?:[.,;:!?)]|&quot;|&#39;|&#039;|&gt;)+$/.exec(url)?.[0] ?? '';
    const href = trailing ? url.slice(0, -trailing.length) : url;
    parts.push({ text: text.slice(offset, match.index), isUrl: false });
    parts.push({ text: href, isUrl: true });
    offset = match.index + href.length;
  }
  parts.push({ text: text.slice(offset), isUrl: false });
  return parts;
};
