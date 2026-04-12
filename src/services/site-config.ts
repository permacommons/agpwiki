import config from 'config';

type SiteConfig = {
  baseUrl: string;
};

const defaultSiteConfig: SiteConfig = {
  baseUrl: 'http://127.0.0.1:3000',
};

export const getSiteConfig = (): SiteConfig => {
  if (typeof config.has === 'function' && config.has('site')) {
    return {
      ...defaultSiteConfig,
      ...config.get<SiteConfig>('site'),
    };
  }
  return defaultSiteConfig;
};

export const getSiteBaseUrl = () => getSiteConfig().baseUrl.replace(/\/+$/, '');
