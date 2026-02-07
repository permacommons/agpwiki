import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

import {
  assertValidPageCheckMetrics,
  PAGE_CHECK_NOTES_MAX_LENGTH,
  PAGE_CHECK_RESULTS_MAX_LENGTH,
  PAGE_CHECK_STATUSES,
  PAGE_CHECK_TYPES,
} from '../../lib/page-checks.js';

const { mlString, types } = dal;

const pageCheckManifest = {
  tableName: 'page_checks',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    pageId: types.string().uuid(4).required(),
    type: types
      .string()
      .max(64)
      .required()
      .validator(value => {
        if (!PAGE_CHECK_TYPES.includes(value as (typeof PAGE_CHECK_TYPES)[number])) {
          throw new Error(`type must be one of: ${PAGE_CHECK_TYPES.join(', ')}`);
        }
        return true;
      }),
    status: types
      .string()
      .max(32)
      .required()
      .validator(value => {
        if (!PAGE_CHECK_STATUSES.includes(value as (typeof PAGE_CHECK_STATUSES)[number])) {
          throw new Error(`status must be one of: ${PAGE_CHECK_STATUSES.join(', ')}`);
        }
        return true;
      }),
    checkResults: mlString.getHTMLSchema({ maxLength: PAGE_CHECK_RESULTS_MAX_LENGTH }).required(),
    notes: mlString.getHTMLSchema({ maxLength: PAGE_CHECK_NOTES_MAX_LENGTH }),
    metrics: types.object().required().validator(assertValidPageCheckMetrics),
    createdAt: types.date().default(() => new Date()),
    completedAt: types.date(),
    targetRevId: types.string().uuid(4).required(),
  },
  camelToSnake: {
    pageId: 'page_id',
    checkResults: 'check_results',
    createdAt: 'created_at',
    completedAt: 'completed_at',
    targetRevId: 'target_rev_id',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type PageCheckInstance = ManifestInstance<typeof pageCheckManifest>;
export type PageCheckModel = ManifestModel<typeof pageCheckManifest>;

export function referencePageCheck(): PageCheckModel {
  return referenceModel(pageCheckManifest) as PageCheckModel;
}

export default pageCheckManifest;
