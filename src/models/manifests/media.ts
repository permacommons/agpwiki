import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

import {
  MEDIA_ALT_TEXT_MAX_LENGTH,
  MEDIA_CAPTION_MAX_LENGTH,
  MEDIA_COMMONS_TITLE_MAX_LENGTH,
  MEDIA_SLUG_MAX_LENGTH,
  MEDIA_TITLE_MAX_LENGTH,
  MEDIA_TYPES,
} from '../../lib/media.js';

const { mlString, types } = dal;

const mediaManifest = {
  tableName: 'media',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    slug: types.string().max(MEDIA_SLUG_MAX_LENGTH).required(),
    title: mlString.getSafeTextSchema({ maxLength: MEDIA_TITLE_MAX_LENGTH }),
    commonsTitle: types.string().max(MEDIA_COMMONS_TITLE_MAX_LENGTH).required(),
    mediaType: types
      .string()
      .max(16)
      .required()
      .validator(value => {
        if (!MEDIA_TYPES.includes(value as (typeof MEDIA_TYPES)[number])) {
          throw new Error(`mediaType must be one of: ${MEDIA_TYPES.join(', ')}`);
        }
        return true;
      }),
    data: types.object().required(),
    caption: mlString.getSafeTextSchema({ maxLength: MEDIA_CAPTION_MAX_LENGTH }),
    altText: mlString.getSafeTextSchema({ maxLength: MEDIA_ALT_TEXT_MAX_LENGTH }),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    commonsTitle: 'commons_title',
    mediaType: 'media_type',
    altText: 'alt_text',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type MediaInstance = ManifestInstance<typeof mediaManifest>;
export type MediaModel = ManifestModel<typeof mediaManifest>;

export function referenceMedia(): MediaModel {
  return referenceModel(mediaManifest) as MediaModel;
}

export default mediaManifest;
