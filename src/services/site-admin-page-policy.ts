import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError } from '../lib/errors.js';
import { toAddressForm } from '../lib/slug.js';
import PageAlias from '../models/page-alias.js';
import { SITE_ADMIN_ROLE, userHasRole } from './roles.js';

const restrictedAddresses = ['meta/privacy'];

export const getSiteAdminPageAddress = async ({ id, slug }: { id?: string; slug: string }) => {
  const address = toAddressForm(slug);
  if (restrictedAddresses.includes(address)) return address;
  if (!id) return null;

  for (const restrictedAddress of restrictedAddresses) {
    const alias = await PageAlias.filterWhere({ pageId: id, slug: restrictedAddress }).first();
    if (alias) return restrictedAddress;
  }
  return null;
};

export const assertCanManageSiteAdminPage = async (
  dal: DataAccessLayer,
  page: { id?: string; slug: string },
  userId: string
) => {
  const slug = await getSiteAdminPageAddress(page);
  if (slug && !(await userHasRole(dal, userId, SITE_ADMIN_ROLE))) {
    throw new ForbiddenError('Only site admins can modify this page or its addresses.', {
      slug,
      requiredRole: SITE_ADMIN_ROLE,
    });
  }
};
