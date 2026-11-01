const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// IDs from addresses and forms go straight into UUID columns, where
// anything else is a database error. Checking first lets callers treat a
// malformed ID like an unknown one.
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);
