import crypto from 'node:crypto';
import config from 'config';

export interface WikiLinkPreviewTokenPayload {
  pagePath: string;
  locale: string;
  exp: number;
}

const getPreviewTokenSecret = (): string =>
  config.get<string>('wikiLinkPreviews.previewTokenSecret');
const getPreviewTokenTtlSeconds = (): number =>
  config.get<number>('wikiLinkPreviews.previewTokenTtlSeconds');

const encodeBase64Url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const decodeBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const signPayload = (encodedPayload: string) =>
  crypto.createHmac('sha256', getPreviewTokenSecret()).update(encodedPayload).digest('base64url');

export const createWikiLinkPreviewToken = ({
  pagePath,
  locale,
  now = Date.now(),
}: {
  pagePath: string;
  locale: string;
  now?: number;
}) => {
  const payload: WikiLinkPreviewTokenPayload = {
    pagePath,
    locale,
    exp: Math.floor(now / 1000) + getPreviewTokenTtlSeconds(),
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
};

export const verifyWikiLinkPreviewToken = (
  token: string,
  now = Date.now()
): WikiLinkPreviewTokenPayload | null => {
  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return null;
  }

  const encodedPayload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = signPayload(encodedPayload);

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      decodeBase64Url(encodedPayload)
    ) as Partial<WikiLinkPreviewTokenPayload>;
    if (
      typeof payload.pagePath !== 'string' ||
      typeof payload.locale !== 'string' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    if (payload.exp < Math.floor(now / 1000)) {
      return null;
    }
    return {
      pagePath: payload.pagePath,
      locale: payload.locale,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
};
