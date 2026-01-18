export type ToolErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'unauthorized'
  | 'invalid_request'
  | 'precondition_failed'
  | 'unsupported'
  | 'internal_error';

export type FieldError = {
  field: string;
  message: string;
  code?: string;
};

export type ToolErrorPayload = {
  error: {
    code: ToolErrorCode;
    message: string;
    fieldErrors?: FieldError[];
    details?: Record<string, unknown>;
    retryable?: boolean;
  };
};

type ToolErrorOptions = {
  fieldErrors?: FieldError[];
  details?: Record<string, unknown>;
  retryable?: boolean;
};

export class McpToolError extends Error {
  code: ToolErrorCode;
  fieldErrors?: FieldError[];
  details?: Record<string, unknown>;
  retryable?: boolean;

  constructor(code: ToolErrorCode, message: string, options: ToolErrorOptions = {}) {
    super(message);
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.details = options.details;
    this.retryable = options.retryable;
  }

  toPayload(): ToolErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        fieldErrors: this.fieldErrors,
        details: this.details,
        retryable: this.retryable,
      },
    };
  }
}

export class ValidationError extends McpToolError {
  constructor(message: string, fieldErrors: FieldError[], details?: Record<string, unknown>) {
    super('validation_error', message, { fieldErrors, details, retryable: false });
  }
}

export class NotFoundError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('not_found', message, { details, retryable: false });
  }
}

export class ConflictError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, { details, retryable: false });
  }
}

export class ForbiddenError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('forbidden', message, { details, retryable: false });
  }
}

export class UnauthorizedError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('unauthorized', message, { details, retryable: false });
  }
}

export class InvalidRequestError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_request', message, { details, retryable: false });
  }
}

export class PreconditionFailedError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('precondition_failed', message, { details, retryable: false });
  }
}

export class UnsupportedError extends McpToolError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('unsupported', message, { details, retryable: false });
  }
}

export class ValidationCollector {
  private fieldErrors: FieldError[] = [];
  private defaultMessage: string;

  constructor(defaultMessage = 'Validation failed.') {
    this.defaultMessage = defaultMessage;
  }

  add(field: string, message: string, code?: string) {
    this.fieldErrors.push({ field, message, code });
  }

  addMissing(field: string) {
    this.add(field, 'is required.', 'required');
  }

  throwIfAny(message = this.defaultMessage) {
    if (this.fieldErrors.length) {
      throw new ValidationError(message, this.fieldErrors);
    }
  }
}

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
  const message = error instanceof Error ? error.message : String(error);
  const code = mapMessageToCode(message);
  return {
    error: {
      code,
      message,
    },
  };
};
