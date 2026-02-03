export type PageCheckSeverityCounts = {
  high: number;
  medium: number;
  low: number;
};

export type PageCheckMetrics = {
  issues_found: PageCheckSeverityCounts;
  issues_fixed: PageCheckSeverityCounts;
};

export type PageCheckMetricError = {
  field: string;
  message: string;
  code: 'required' | 'type' | 'invalid' | 'range';
};

export const PAGE_CHECK_TYPES = [
  'fact_check',
  'copy_edit',
  'structure_review',
  'freshness_check',
  'link_integrity',
  'plagiarism_scan',
  'accessibility_check',
  'translation_review',
  'formatting_check',
] as const;

export const PAGE_CHECK_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export const PAGE_CHECK_RESULTS_MAX_LENGTH = 2000;
export const PAGE_CHECK_NOTES_MAX_LENGTH = 10000;

const severityKeys = ['high', 'medium', 'low'] as const;
const metricsKeys = ['issues_found', 'issues_fixed'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
};

const addMissing = (errors: PageCheckMetricError[], field: string) => {
  errors.push({ field, message: 'is required.', code: 'required' });
};

const addTypeError = (errors: PageCheckMetricError[], field: string, message: string) => {
  errors.push({ field, message, code: 'type' });
};

const addInvalidError = (errors: PageCheckMetricError[], field: string, message: string) => {
  errors.push({ field, message, code: 'invalid' });
};

const addRangeError = (errors: PageCheckMetricError[], field: string, message: string) => {
  errors.push({ field, message, code: 'range' });
};

const validateSeverityCounts = (
  value: unknown,
  fieldPrefix: string,
  errors: PageCheckMetricError[]
): PageCheckSeverityCounts | null => {
  if (!isPlainObject(value)) {
    addTypeError(errors, fieldPrefix, `${fieldPrefix} must be an object.`);
    return null;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (!severityKeys.includes(key as (typeof severityKeys)[number])) {
      addInvalidError(errors, `${fieldPrefix}.${key}`, 'is not allowed.');
    }
  }

  const counts: PageCheckSeverityCounts = { high: 0, medium: 0, low: 0 };

  for (const key of severityKeys) {
    const field = `${fieldPrefix}.${key}`;
    if (!Object.hasOwn(value, key)) {
      addMissing(errors, field);
      continue;
    }
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      addTypeError(errors, field, 'must be a number.');
      continue;
    }
    if (!Number.isInteger(raw)) {
      addInvalidError(errors, field, 'must be an integer.');
      continue;
    }
    if (raw < 0) {
      addRangeError(errors, field, 'must be greater than or equal to 0.');
      continue;
    }
    counts[key] = raw;
  }

  return counts;
};

export const getPageCheckMetricsErrors = (value: unknown): PageCheckMetricError[] => {
  const errors: PageCheckMetricError[] = [];

  if (!isPlainObject(value)) {
    addTypeError(errors, 'metrics', 'metrics must be an object.');
    return errors;
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (!metricsKeys.includes(key as (typeof metricsKeys)[number])) {
      addInvalidError(errors, `metrics.${key}`, 'is not allowed.');
    }
  }

  for (const key of metricsKeys) {
    if (!Object.hasOwn(value, key)) {
      addMissing(errors, `metrics.${key}`);
    }
  }

  const issuesFound = validateSeverityCounts(
    (value as Record<string, unknown>).issues_found,
    'metrics.issues_found',
    errors
  );
  const issuesFixed = validateSeverityCounts(
    (value as Record<string, unknown>).issues_fixed,
    'metrics.issues_fixed',
    errors
  );

  if (issuesFound && issuesFixed) {
    for (const key of severityKeys) {
      if (issuesFixed[key] > issuesFound[key]) {
        addRangeError(
          errors,
          `metrics.issues_fixed.${key}`,
          'must be less than or equal to metrics.issues_found.'
        );
      }
    }
  }

  return errors;
};

export const assertValidPageCheckMetrics = (value: unknown): true => {
  const errors = getPageCheckMetricsErrors(value);
  if (errors.length) {
    const message = errors.map(error => `${error.field} ${error.message}`).join(' ');
    throw new Error(message);
  }
  return true;
};
