import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

import {
  CITATION_CLAIM_ASSERTION_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_TYPES,
  CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH,
  CITATION_CLAIM_QUOTE_MAX_LENGTH,
} from '../../lib/citation-claims.js';

const { mlString, types } = dal;

const citationClaimManifest = {
  tableName: 'citation_claims',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    citationId: types.string().uuid(4).required(),
    claimId: types.string().max(200).required(),
    assertion: mlString
      .getSafeTextSchema({ maxLength: CITATION_CLAIM_ASSERTION_MAX_LENGTH })
      .required(),
    quote: mlString.getSafeTextSchema({ maxLength: CITATION_CLAIM_QUOTE_MAX_LENGTH }),
    quoteLanguage: types.string().max(8),
    locatorType: types
      .string()
      .max(32)
      .validator(value => {
        if (!CITATION_CLAIM_LOCATOR_TYPES.includes(value as (typeof CITATION_CLAIM_LOCATOR_TYPES)[number])) {
          throw new Error(`locatorType must be one of: ${CITATION_CLAIM_LOCATOR_TYPES.join(', ')}`);
        }
        return true;
      }),
    locatorValue: mlString.getSafeTextSchema({
      maxLength: CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH,
    }),
    locatorLabel: mlString.getSafeTextSchema({
      maxLength: CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH,
    }),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    citationId: 'citation_id',
    claimId: 'claim_id',
    quoteLanguage: 'quote_language',
    locatorType: 'locator_type',
    locatorValue: 'locator_value',
    locatorLabel: 'locator_label',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type CitationClaimInstance = ManifestInstance<typeof citationClaimManifest>;
export type CitationClaimModel = ManifestModel<typeof citationClaimManifest>;

export function referenceCitationClaim(): CitationClaimModel {
  return referenceModel(citationClaimManifest) as CitationClaimModel;
}

export default citationClaimManifest;
