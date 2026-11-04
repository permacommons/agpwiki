import assert from 'node:assert/strict';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';
import { formatTime, parseLocalDate, parseWikidataTime, yearsBetween } from '../src/lib/infobox-dates.js';
import { GREGORIAN_CALENDAR, JULIAN_CALENDAR } from '../src/lib/wikidata.js';

const t = i18next.t.bind(i18next);

test('Local dates enforce Gregorian calendar boundaries', () => {
  for (const value of ['1964-13-40', '2024-00', '2024-01-00', '2024-04-31', '2023-02-29', '1900-02-29', '0000', 'May 30, 1964']) {
    assert.equal(parseLocalDate(value), null, value);
  }
  for (const value of ['1964', '1964-05', '1964-05-30', '2024-02-29', '2000-02-29', '0001-01-01', '-0044', '-0044-03-15']) {
    assert.ok(parseLocalDate(value), value);
  }
});

test('Date formatting preserves BCE precision and calendar information', () => {
  for (const [value, expected] of [
    ['-0044', '44 BC'],
    ['-0044-03', 'March 44 BC'],
    ['-0044-03-15', 'March 15, 44 BC'],
  ]) {
    const date = parseLocalDate(value);
    assert.ok(date);
    assert.equal(formatTime(date, 'en', t), expected);
    const remote = parseWikidataTime('-0044-03-15T00:00:00Z', date.precision, GREGORIAN_CALENDAR);
    assert.ok(remote);
    assert.equal(formatTime(remote, 'en', t), expected);
  }
  const julian = parseWikidataTime('+1900-02-29T00:00:00Z', 11, JULIAN_CALENDAR);
  assert.ok(julian);
  assert.equal(formatTime(julian, 'en', t), 'February 29, 1900 (Julian calendar)');
  assert.equal(formatTime({ ...julian, calendarModel: undefined }, 'en', t), 'February 29, 1900 (calendar unknown)');
});

test('Whole-year ages respect precision, birthdays, eras, and calendar compatibility', () => {
  assert.equal(yearsBetween(parseLocalDate('-0001-06-15'), parseLocalDate('0001-06-15')), 1);
  assert.equal(yearsBetween(parseLocalDate('1964-05-30'), parseLocalDate('2026-05-29')), 61);
  assert.equal(yearsBetween(parseLocalDate('1964-05-30'), parseLocalDate('2026-05-30')), 62);
  assert.equal(yearsBetween(parseLocalDate('1964'), parseLocalDate('2026-05-30')), null);
  assert.equal(yearsBetween(parseLocalDate('2026-05-30'), parseLocalDate('1964-05-30')), null);
  assert.equal(yearsBetween(null, parseLocalDate('2026-05-30')), null);
  const birth = parseWikidataTime('+1900-03-01T00:00:00Z', 11, JULIAN_CALENDAR);
  const death = parseWikidataTime('+1980-03-05T00:00:00Z', 11, JULIAN_CALENDAR);
  assert.ok(birth && death);
  assert.equal(yearsBetween(birth, death), 80);
  assert.equal(yearsBetween(birth, { ...death, calendarModel: GREGORIAN_CALENDAR }), null);
  assert.equal(yearsBetween(birth, { ...death, calendarModel: undefined }), null);
  assert.equal(yearsBetween({ ...birth, calendarModel: 'unsupported' }, { ...death, calendarModel: 'unsupported' }), null);
});
