export const isJsonParseError = (error: unknown): boolean => {
  if (!(error instanceof SyntaxError)) return false;
  const maybeError = error as { type?: string; status?: number; body?: unknown; message?: string };
  if (maybeError.type === 'entity.parse.failed') return true;
  if (typeof maybeError.status === 'number' && maybeError.status === 400) return true;
  if (typeof maybeError.message === 'string' && maybeError.message.toLowerCase().includes('json')) {
    return true;
  }
  return false;
};
