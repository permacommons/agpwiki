import type { AccountLifecycleState } from '../src/services/account-lifecycle.js';
import type { layoutAssets } from '../src/asset-urls.js';
import type { LanguageOption } from '../src/render.js';

declare global {
  namespace Express {
    interface Locals {
      locale: AgpWiki.LocaleCode;
      languageOptions: LanguageOption[];
      signedIn: boolean;
      currentUserId: string | null;
      currentUserName: string | null;
      currentPath: string;
      accountState: AccountLifecycleState | null;
      accountBannerHtml: string;
      assets: typeof layoutAssets;
      isSiteAdmin: boolean;
    }
  }
}
