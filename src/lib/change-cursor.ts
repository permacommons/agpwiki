import { ValidationError } from './errors.js';
import { isUuid } from './uuid.js';

// A cursor marks a place in a list sorted oldest first: the time of the
// last item returned and its ID, which breaks ties between items saved in
// the same microsecond. Times keep Postgres's microseconds, which a JS Date
// would round away, so the next page neither skips nor repeats an item.
export interface ChangeCursor {
  time: string;
  id: string;
}

// The SQL expression that writes a timestamp in the form cursors use.
// Strings in this form sort the same way as the times they stand for.
export const cursorTimeSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export const encodeChangeCursor = (cursor: ChangeCursor) =>
  Buffer.from(`${cursor.time}|${cursor.id}`, 'utf8').toString('base64url');

export const decodeChangeCursor = (value: string, field = 'cursor'): ChangeCursor => {
  const [time, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (rest.length || !time || !CURSOR_TIME_PATTERN.test(time) || !id || !isUuid(id)) {
    const message = 'Not a cursor from an earlier answer. Pass the cursor exactly as it was returned.';
    throw new ValidationError(message, [{ field, message, code: 'invalid' }]);
  }
  return { time, id: id.toLowerCase() };
};

// The maximum UUID excludes every ID at the starting timestamp.
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export const cursorFromDate = (date: Date): ChangeCursor => ({
  time: date.toISOString().replace(/Z$/, '000Z'),
  id: MAX_UUID,
});

/**
 * The starting point of a list: the cursor passed back from an earlier
 * answer, else a date, else the given default.
 */
export const resolveStartCursor = (
  { cursor, since }: { cursor?: string | null; since?: string | null },
  fallback: () => ChangeCursor
): ChangeCursor => {
  if (cursor) return decodeChangeCursor(cursor);
  if (since) {
    const date = new Date(since);
    if (Number.isNaN(date.getTime())) {
      const message = 'Expected a date and time such as "2026-11-05T12:00:00Z".';
      throw new ValidationError(message, [{ field: 'since', message, code: 'invalid' }]);
    }
    return cursorFromDate(date);
  }
  return fallback();
};
