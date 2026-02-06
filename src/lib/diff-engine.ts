import { createTwoFilesPatch, diffLines } from 'diff';

import { normalizeForDiff } from '../render.js';

export type TextDiff = {
  unifiedDiff: string;
  stats: { addedLines: number; removedLines: number };
  from: string;
  to: string;
};

export type LocalizedDiff = {
  kind: 'localized';
  added: Array<{ lang: string; value: string }>;
  removed: Array<{ lang: string; value: string }>;
  modified: Record<string, TextDiff>;
};

export type ScalarDiff = {
  kind: 'scalar';
  from: string | null;
  to: string | null;
};

export type StructuredChange = {
  path: string;
  type: 'added' | 'removed' | 'modified';
  from?: string;
  to?: string;
};

export type StructuredDiff = {
  kind: 'structured';
  changes: StructuredChange[];
};

export type TextFieldDiff = {
  kind: 'text';
  diff: TextDiff;
};

export type FieldDiff = LocalizedDiff | ScalarDiff | StructuredDiff | TextFieldDiff;

const countLines = (text: string) => {
  if (!text) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
};

const buildTextDiff = (fieldName: string, fromValue: string, toValue: string): TextDiff => {
  const fromNormalized = normalizeForDiff(fromValue);
  const toNormalized = normalizeForDiff(toValue);
  const unifiedDiff = createTwoFilesPatch(
    fieldName,
    fieldName,
    fromNormalized,
    toNormalized,
    '',
    '',
    { context: 2 }
  );
  const lineDiff = diffLines(fromNormalized, toNormalized);
  let addedLines = 0;
  let removedLines = 0;

  for (const chunk of lineDiff) {
    if (chunk.added) addedLines += countLines(chunk.value);
    if (chunk.removed) removedLines += countLines(chunk.value);
  }

  return {
    unifiedDiff,
    stats: { addedLines, removedLines },
    from: fromValue,
    to: toValue,
  };
};

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input as object)) return '[Circular]';
    seen.add(input as object);
    if (Array.isArray(input)) return input.map(normalize);
    const entries = Object.entries(input as Record<string, unknown>).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    const result: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      result[key] = normalize(value);
    }
    return result;
  };

  return JSON.stringify(normalize(value), null, 2);
};

const isEqual = (left: unknown, right: unknown): boolean =>
  stableStringify(left) === stableStringify(right);

const escapePathSegment = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');

const joinPath = (base: string, segment: string) =>
  base ? `${base}/${escapePathSegment(segment)}` : `/${escapePathSegment(segment)}`;

const diffStructuredValue = (
  fromValue: unknown,
  toValue: unknown,
  basePath: string,
  changes: StructuredChange[]
) => {
  if (isEqual(fromValue, toValue)) return;

  const fromIsObject = typeof fromValue === 'object' && fromValue !== null;
  const toIsObject = typeof toValue === 'object' && toValue !== null;

  if (Array.isArray(fromValue) || Array.isArray(toValue)) {
    const fromArray = Array.isArray(fromValue) ? fromValue : [];
    const toArray = Array.isArray(toValue) ? toValue : [];
    const max = Math.max(fromArray.length, toArray.length);
    for (let i = 0; i < max; i += 1) {
      const fromItem = fromArray[i];
      const toItem = toArray[i];
      if (i >= fromArray.length) {
        changes.push({
          path: joinPath(basePath, String(i)),
          type: 'added',
          to: stableStringify(toItem),
        });
        continue;
      }
      if (i >= toArray.length) {
        changes.push({
          path: joinPath(basePath, String(i)),
          type: 'removed',
          from: stableStringify(fromItem),
        });
        continue;
      }
      diffStructuredValue(fromItem, toItem, joinPath(basePath, String(i)), changes);
    }
    return;
  }

  if (fromIsObject && toIsObject) {
    const fromObj = fromValue as Record<string, unknown>;
    const toObj = toValue as Record<string, unknown>;
    const keys = new Set([...Object.keys(fromObj), ...Object.keys(toObj)]);
    for (const key of [...keys].sort()) {
      if (!Object.hasOwn(fromObj, key)) {
        changes.push({
          path: joinPath(basePath, key),
          type: 'added',
          to: stableStringify(toObj[key]),
        });
        continue;
      }
      if (!Object.hasOwn(toObj, key)) {
        changes.push({
          path: joinPath(basePath, key),
          type: 'removed',
          from: stableStringify(fromObj[key]),
        });
        continue;
      }
      diffStructuredValue(fromObj[key], toObj[key], joinPath(basePath, key), changes);
    }
    return;
  }

  changes.push({
    path: basePath || '/',
    type: 'modified',
    from: stableStringify(fromValue),
    to: stableStringify(toValue),
  });
};

export const diffLocalizedField = (
  fieldName: string,
  fromValue: Record<string, string> | null | undefined,
  toValue: Record<string, string> | null | undefined
): LocalizedDiff | null => {
  const fromMap = fromValue ?? {};
  const toMap = toValue ?? {};
  const fromKeys = new Set(Object.keys(fromMap));
  const toKeys = new Set(Object.keys(toMap));
  const added = [...toKeys]
    .filter(key => !fromKeys.has(key))
    .sort()
    .map(key => ({ lang: key, value: toMap[key] ?? '' }));
  const removed = [...fromKeys]
    .filter(key => !toKeys.has(key))
    .sort()
    .map(key => ({ lang: key, value: fromMap[key] ?? '' }));
  const modified: Record<string, TextDiff> = {};

  for (const key of [...toKeys].filter(k => fromKeys.has(k)).sort()) {
    const fromText = fromMap[key] ?? '';
    const toText = toMap[key] ?? '';
    if (fromText !== toText) {
      modified[key] = buildTextDiff(`${fieldName}.${key}`, fromText, toText);
    }
  }

  if (!added.length && !removed.length && Object.keys(modified).length === 0) {
    return null;
  }

  return { kind: 'localized', added, removed, modified };
};

export const diffTextField = (
  fieldName: string,
  fromValue: string | null | undefined,
  toValue: string | null | undefined
): TextFieldDiff | null => {
  const fromText = fromValue ?? '';
  const toText = toValue ?? '';
  if (fromText === toText) return null;
  return { kind: 'text', diff: buildTextDiff(fieldName, fromText, toText) };
};

const normalizeScalar = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stableStringify(value);
};

export const diffScalarField = (
  _fieldName: string,
  fromValue: unknown,
  toValue: unknown
): ScalarDiff | null => {
  const from = normalizeScalar(fromValue);
  const to = normalizeScalar(toValue);
  if (from === to) return null;
  return { kind: 'scalar', from, to };
};

export const diffStructuredField = (
  _fieldName: string,
  fromValue: unknown,
  toValue: unknown
): StructuredDiff | null => {
  if (isEqual(fromValue, toValue)) return null;
  const changes: StructuredChange[] = [];
  diffStructuredValue(fromValue, toValue, '', changes);
  if (!changes.length) return null;
  return { kind: 'structured', changes };
};
