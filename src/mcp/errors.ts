export {
  ConflictError,
  type FieldError,
  ForbiddenError,
  InvalidRequestError,
  McpToolError,
  NotFoundError,
  PreconditionFailedError,
  type ToolErrorCode,
  type ToolErrorPayload,
  UnauthorizedError,
  UnsupportedError,
  ValidationCollector,
  ValidationError,
} from '../lib/errors.js';

import {
  type FieldError,
  McpToolError,
  type ToolErrorCode,
  type ToolErrorPayload,
  ValidationError,
} from '../lib/errors.js';

type ZodIssueLike = {
  code: string;
  path?: Array<string | number>;
  message: string;
  input?: unknown;
};

const mapZodIssueToFieldError = (issue: ZodIssueLike): FieldError => {
  const field = issue.path?.length ? issue.path.join('.') : 'value';
  let code: string | undefined;

  if (issue.code === 'invalid_type') {
    if (issue.input === undefined) {
      if (issue.message.endsWith('is required.')) {
        code = 'required';
      } else {
        code = 'type';
      }
    } else {
      code = 'type';
    }
  } else if (issue.code === 'custom') {
    code = 'invalid';
  }

  return {
    field,
    message: issue.message,
    code,
  };
};

export const toValidationErrorFromZod = (
  message: string,
  issues: ZodIssueLike[]
): ValidationError => {
  const fieldErrors = issues.map(mapZodIssueToFieldError);
  return new ValidationError(message, fieldErrors);
};

const mapMessageToCode = (message: string): ToolErrorCode => {
  const normalized = message.toLowerCase();
  if (normalized.includes('not found')) return 'not_found';
  if (normalized.includes('already exists') || normalized.includes('conflict')) return 'conflict';
  if (normalized.includes('forbidden') || normalized.includes('does not have')) return 'forbidden';
  if (normalized.includes('unauthorized') || normalized.includes('authorization')) return 'unauthorized';
  if (
    normalized.includes('must be') ||
    normalized.includes('is required') ||
    normalized.includes('must include')
  ) {
    return 'validation_error';
  }
  if (
    normalized.includes('invalid mcp resource') ||
    normalized.includes('unknown mcp resource') ||
    normalized.includes('missing')
  ) {
    return 'invalid_request';
  }
  if (normalized.includes('patch could not be applied') || normalized.includes('did not change')) {
    return 'precondition_failed';
  }
  if (normalized.includes('patch format not supported') || normalized.includes('patch target mismatch')) {
    return 'invalid_request';
  }
  return 'internal_error';
};

export const toToolErrorPayload = (error: unknown): ToolErrorPayload => {
  if (error instanceof McpToolError) {
    return error.toPayload();
  }
  const dalError = error as { name?: string; message?: string; field?: string | null } | null;
  if (dalError?.name === 'ValidationError') {
    const field = dalError.field ?? undefined;
    const message = dalError.message ?? 'Validation error.';
    const fieldErrors = field
      ? [{ field, message, code: 'invalid' } satisfies FieldError]
      : undefined;
    return {
      error: {
        code: 'validation_error',
        message,
        fieldErrors,
        retryable: false,
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = mapMessageToCode(message);
  return {
    error: {
      code,
      message,
    },
  };
};
