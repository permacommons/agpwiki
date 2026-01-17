type CitationData = Record<string, unknown> | null;

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const formatAuthorName = (author: Record<string, unknown>) => {
  const literal = normalizeString(author.literal);
  if (literal) return literal;
  const family = normalizeString(author.family);
  const given = normalizeString(author.given);
  if (family && given) return `${family}, ${given}`;
  return family || given;
};

export const formatCitationLabel = (key: string, data: CitationData) => {
  const title = normalizeString(data?.title);
  return title ? `${key} - ${title}` : key;
};

export const formatCitationPageTitle = (key: string, data: CitationData) => {
  const title = normalizeString(data?.title);
  const container = normalizeString(data?.['container-title']);
  const publisher = normalizeString(data?.publisher);
  if (title && container) return `${title} — ${container}`;
  if (title && publisher) return `${title} — ${publisher}`;
  if (title) return title;
  return key;
};

export const formatCitationAuthors = (data: CitationData) => {
  const authors = Array.isArray(data?.author) ? data?.author : [];
  const names = authors
    .map(author =>
      author && typeof author === 'object'
        ? formatAuthorName(author as Record<string, unknown>)
        : ''
    )
    .filter(Boolean);
  return names.join('; ');
};

export const formatCitationIssued = (data: CitationData) => {
  const issued = data?.issued;
  const issuedObject =
    issued && typeof issued === 'object' ? (issued as Record<string, unknown>) : null;
  const datePartsValue = issuedObject ? issuedObject['date-parts'] : null;
  const dateParts = Array.isArray(datePartsValue) ? datePartsValue[0] : null;
  if (!Array.isArray(dateParts) || dateParts.length === 0) return '';
  return dateParts.map(part => String(part)).join('-');
};

export const formatCitationJson = (data: CitationData) =>
  JSON.stringify(data ?? {}, null, 2);
