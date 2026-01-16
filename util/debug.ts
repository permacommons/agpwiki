import type { Debugger } from 'debug';
import debugModule from 'debug';
import type { Request } from 'express';

const SENSITIVE_LOG_KEYS = new Set<string>([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken',
]);

type SerializableObject = Record<string, unknown>;

type RequestLike =
  | Pick<Request, 'method' | 'originalUrl' | 'body' | 'route'>
  | {
      route?: { path?: string };
      method?: string;
      originalUrl?: string;
      body?: unknown;
    };

export interface DebugErrorContext {
  req?: RequestLike;
  error?: Error & { stack?: string };
}

export type DebugErrorDetail = DebugErrorContext | Error | string | null | undefined;

export interface DebugLoggerMap {
  db: Debugger;
  app: Debugger;
  util: Debugger;
  i18n: Debugger;
  tests: Debugger;
  adapters: Debugger;
  webhooks: Debugger;
  errorLog: Debugger;
  error: DebugErrorFunction;
}

export interface DebugErrorFunction {
  (this: DebugLoggerMap, message: string, detail?: DebugErrorDetail): void;
  (this: DebugLoggerMap, detail: DebugErrorDetail): void;
}

function sanitizeForLogging<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map(item => sanitizeForLogging(item)) as unknown as T;

  const sanitized: SerializableObject = {};

  for (const [key, val] of Object.entries(value as SerializableObject)) {
    if (SENSITIVE_LOG_KEYS.has(key)) {
      sanitized[key] = '<redacted>';
    } else {
      sanitized[key] = sanitizeForLogging(val);
    }
  }

  return sanitized as T;
}

const logDetail = (logger: Debugger, detail: DebugErrorDetail): void => {
  if (!detail) {
    return;
  }

  if (typeof detail === 'string') {
    logger(detail);
    return;
  }

  if (detail instanceof Error) {
    logger('Stacktrace:');
    logger(detail.stack ?? String(detail));
    return;
  }

  const request = detail.req;

  if (request) {
    if (request.route && 'path' in request.route && request.route.path)
      logger(`Error occurred in route <${request.route.path}>.`);

    if (request.method || request.originalUrl)
      logger(
        `Request method: ${request.method ?? 'UNKNOWN'} - URL: ${request.originalUrl ?? 'UNKNOWN'}`
      );

    if (request.method !== 'GET' && request.body !== undefined) {
      logger('Request body:');
      if (typeof request.body === 'object') {
        logger(JSON.stringify(sanitizeForLogging(request.body), null, 2));
      } else {
        logger('<omitted>');
      }
    }
  }

  if (detail.error) {
    logger('Stacktrace:');
    logger(detail.error.stack ?? String(detail.error));
  }
};

const debug: DebugLoggerMap = {
  db: debugModule('agpwiki:db'),
  app: debugModule('agpwiki:app'),
  util: debugModule('agpwiki:util'),
  i18n: debugModule('agpwiki:i18n'),
  tests: debugModule('agpwiki:tests'),
  adapters: debugModule('agpwiki:adapters'),
  webhooks: debugModule('agpwiki:webhooks'),
  errorLog: debugModule('agpwiki:error'),

  error(
    this: DebugLoggerMap,
    first: string | DebugErrorDetail,
    maybeDetail?: DebugErrorDetail
  ): void {
    const log = this.errorLog;

    if (typeof first === 'string') {
      log(first);
      if (maybeDetail !== undefined) {
        logDetail(log, maybeDetail);
      }
      return;
    }

    logDetail(log, first);
  },
};

export default debug;
export { sanitizeForLogging };
