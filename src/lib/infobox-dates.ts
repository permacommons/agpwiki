import type { TFunction } from 'i18next';
import { GREGORIAN_CALENDAR, JULIAN_CALENDAR } from './wikidata.js';

export interface ParsedTime {
  year: number;
  month: number;
  day: number;
  precision: number;
  calendarModel?: string;
}

export const parseWikidataTime = (time: string, precision: number, calendarModel?: string): ParsedTime | null => {
  const match = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(time);
  if (!match) return null;
  const year = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return { year, month: Number(match[3]), day: Number(match[4]), precision, calendarModel };
};

/** A date written on Agpedia (1964, 1964-05 or 1964-05-30), or null. */
export const parseLocalDate = (value: string): ParsedTime | null => {
  const match = /^(-?)(\d{1,4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  const month = match[3] ? Number(match[3]) : 0;
  const day = match[4] ? Number(match[4]) : 0;
  if (year === 0 || (match[3] && (month < 1 || month > 12))) return null;
  // Gregorian leap-year arithmetic uses astronomical years, unlike the stored BCE numbering.
  const calendarYear = year < 0 ? year + 1 : year;
  const leapYear = calendarYear % 4 === 0 && (calendarYear % 100 !== 0 || calendarYear % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (match[4] && (day < 1 || day > daysInMonth[month - 1])) return null;
  return { year, month, day, precision: match[4] ? 11 : match[3] ? 10 : 9, calendarModel: GREGORIAN_CALENDAR };
};

const formatDateParts = (parsed: ParsedTime, locale: string, includeDay: boolean, t: TFunction): string => {
  // A leap-year anchor preserves Julian dates such as 29 February 1900 without Gregorian normalization.
  const anchor = new Date(Date.UTC(2000, Math.max(parsed.month, 1) - 1, Math.max(parsed.day, 1)));
  const yearNumber = new Intl.NumberFormat(locale, { useGrouping: false }).format(Math.abs(parsed.year));
  const year = parsed.year < 0 ? t('infobox.yearBce', { year: yearNumber }) : yearNumber;
  return new Intl.DateTimeFormat(locale, {
    calendar: 'gregory', year: 'numeric', month: 'long', ...(includeDay ? { day: 'numeric' as const } : {}), timeZone: 'UTC',
  }).formatToParts(anchor).map(part => part.type === 'year' ? year : part.value).join('');
};

const formatTimeFields = (parsed: ParsedTime, locale: string, t: TFunction): string => {
  if (parsed.year === 0) return '0';
  if (parsed.precision >= 11 && parsed.month && parsed.day) {
    return formatDateParts(parsed, locale, true, t);
  }
  if (parsed.precision === 10 && parsed.month) {
    return formatDateParts(parsed, locale, false, t);
  }
  if (parsed.year < 0) return t('infobox.yearBce', { year: Math.abs(parsed.year) });
  if (parsed.precision === 8) return t('infobox.decade', { year: Math.floor(parsed.year / 10) * 10 });
  // A century is shown as its years, "1800s".
  if (parsed.precision === 7) return t('infobox.decade', { year: Math.floor((parsed.year - 1) / 100) * 100 });
  return String(parsed.year);
};

export const formatTime = (parsed: ParsedTime, locale: string, t: TFunction): string => {
  const date = formatTimeFields(parsed, locale, t);
  if (parsed.calendarModel === GREGORIAN_CALENDAR) return date;
  return t(parsed.calendarModel === JULIAN_CALENDAR ? 'infobox.julianDate' : 'infobox.unknownCalendarDate', { date });
};

/** Whole years from `from` to `to`, when both dates are known to the day. */
export const yearsBetween = (from: ParsedTime | null, to: ParsedTime | null): number | null => {
  if (!from || !to || !from.year || !to.year || from.precision < 11 || to.precision < 11) return null;
  if (!from.calendarModel || from.calendarModel !== to.calendarModel ||
    ![GREGORIAN_CALENDAR, JULIAN_CALENDAR].includes(from.calendarModel)) return null;
  let years = to.year - from.year;
  // Wikidata JSON uses historical years, with no year zero between BCE and CE.
  if (from.year < 0 && to.year > 0) years -= 1;
  if (to.month < from.month || (to.month === from.month && to.day < from.day)) years -= 1;
  return years >= 0 ? years : null;
};
