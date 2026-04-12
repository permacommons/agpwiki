import config from 'config';
import type { Request } from 'express';

type RateLimitRuleConfig = {
  maxAttempts: number;
  windowMs: number;
};

type RateLimitConfig = {
  login: RateLimitRuleConfig;
  resendConfirmationEmail: RateLimitRuleConfig;
  signup: RateLimitRuleConfig;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const defaultRateLimitConfig: RateLimitConfig = {
  login: {
    maxAttempts: 10,
    windowMs: 15 * 60 * 1000,
  },
  resendConfirmationEmail: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
  },
  signup: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
  },
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export const getRateLimitConfig = (): RateLimitConfig => {
  if (typeof config.has === 'function' && config.has('rateLimits')) {
    const configured = config.get<Partial<RateLimitConfig>>('rateLimits');
    return {
      login: {
        ...defaultRateLimitConfig.login,
        ...configured.login,
      },
      resendConfirmationEmail: {
        ...defaultRateLimitConfig.resendConfirmationEmail,
        ...configured.resendConfirmationEmail,
      },
      signup: {
        ...defaultRateLimitConfig.signup,
        ...configured.signup,
      },
    };
  }

  return defaultRateLimitConfig;
};

const getClientIp = (req: Request) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string') {
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  if (Array.isArray(forwardedFor) && forwardedFor[0]) {
    return forwardedFor[0];
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
};

export const getRateLimitKey = (req: Request, scope: string) => `${scope}:${getClientIp(req)}`;

export const consumeRateLimit = (
  scope: keyof RateLimitConfig,
  key: string,
  now = Date.now()
) => {
  const rule = getRateLimitConfig()[scope];
  const bucketKey = `${scope}:${key}`;
  const current = rateLimitBuckets.get(bucketKey);

  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + rule.windowMs,
    });
    return { allowed: true as const, retryAfterSeconds: 0 };
  }

  if (current.count >= rule.maxAttempts) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  rateLimitBuckets.set(bucketKey, current);
  return { allowed: true as const, retryAfterSeconds: 0 };
};

export const resetRateLimitBuckets = () => {
  rateLimitBuckets.clear();
};
