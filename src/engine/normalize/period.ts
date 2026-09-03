import { DATES } from '../config';
import type { DateOnly, PeriodKey } from '../types';
import { toDateOnly } from '../validate/dates';

/**
 * Tax periods, financial years and the arithmetic between them.
 *
 * Everything here works on `"YYYY-MM"` and `"YYYY-MM-DD"` strings. Dates are converted
 * to UTC milliseconds only inside a function and never returned that way, so no
 * timezone can shift a document into a different month than the one it was issued in.
 */

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface PeriodParts {
  year: number;
  /** 1-12. */
  month: number;
}

export function isPeriodKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function periodParts(period: PeriodKey): PeriodParts | null {
  if (!isPeriodKey(period)) return null;
  return {
    year: Number.parseInt(period.slice(0, 4), 10),
    month: Number.parseInt(period.slice(5, 7), 10),
  };
}

export function makePeriod(year: number, month: number): PeriodKey {
  // Normalise an out-of-range month into the right year, so addMonths stays simple.
  const zeroBased = month - 1;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12;
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * The period a document belongs to, taken from its own date.
 *
 * For a monthly filer this is also the GSTR-2B period the credit should appear in: the
 * supplier reports the month in their GSTR-1 by the 11th of the next month, and the
 * buyer's 2B for that month is generated on the 14th.
 */
export function periodFromDate(date: DateOnly): PeriodKey | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date.slice(0, 7);
}

export function comparePeriods(a: PeriodKey, b: PeriodKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addMonths(period: PeriodKey, months: number): PeriodKey | null {
  const parts = periodParts(period);
  if (!parts) return null;
  return makePeriod(parts.year, parts.month + months);
}

/** Whole months from `from` to `to`. Negative when `to` precedes `from`. */
export function monthsBetween(from: PeriodKey, to: PeriodKey): number | null {
  const a = periodParts(from);
  const b = periodParts(to);
  if (!a || !b) return null;
  return (b.year - a.year) * 12 + (b.month - a.month);
}

export function formatPeriod(period: PeriodKey): string {
  const parts = periodParts(period);
  if (!parts) return period;
  return `${MONTH_NAMES[parts.month - 1] ?? '??'} ${String(parts.year)}`;
}

// ------------------------------------------------------------ financial year

export interface FinancialYear {
  /** Calendar year the FY starts in. FY 2026-27 starts in 2026. */
  startYear: number;
  endYear: number;
  /** `"2026-27"`. */
  label: string;
}

/** The Indian financial year runs 1 April to 31 March. */
export function financialYearOfPeriod(period: PeriodKey): FinancialYear | null {
  const parts = periodParts(period);
  if (!parts) return null;

  const startYear =
    parts.month >= DATES.financialYearStartMonth ? parts.year : parts.year - 1;

  return {
    startYear,
    endYear: startYear + 1,
    label: `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`,
  };
}

export function financialYearOfDate(date: DateOnly): FinancialYear | null {
  const period = periodFromDate(date);
  return period ? financialYearOfPeriod(period) : null;
}

/**
 * The date after which input tax credit for a document can no longer be claimed:
 * 30 November following the end of the document's financial year.
 *
 * An invoice dated 10 May 2025 and one dated 10 February 2026 are both in FY 2025-26,
 * so both expire on 30 November 2026 -- the February one has barely nine months of
 * slack while the May one has eighteen. That asymmetry is exactly what the pending
 * ageing countdown exists to make visible.
 */
export function section16_4Deadline(date: DateOnly): DateOnly | null {
  const fy = financialYearOfDate(date);
  if (!fy) return null;
  return toDateOnly(fy.endYear, DATES.section16_4DeadlineMonth, DATES.section16_4DeadlineDay);
}

// -------------------------------------------------------------- quarters

export interface Quarter {
  /** 1-4, following the financial year: Q1 is April-June. */
  index: 1 | 2 | 3 | 4;
  startPeriod: PeriodKey;
  endPeriod: PeriodKey;
  label: string;
}

/**
 * The QRMP quarter a period falls in. Quarters follow the financial year, so Q4 is
 * January to March -- it spans a calendar year boundary, which is why this cannot be
 * done with a plain `Math.floor(month / 3)`.
 */
export function quarterOfPeriod(period: PeriodKey): Quarter | null {
  const parts = periodParts(period);
  if (!parts) return null;

  // Shift so that April becomes 0.
  const shifted = (parts.month - DATES.financialYearStartMonth + 12) % 12;
  const index = (Math.floor(shifted / 3) + 1) as 1 | 2 | 3 | 4;

  const startMonthShifted = Math.floor(shifted / 3) * 3;
  const startMonth = ((startMonthShifted + DATES.financialYearStartMonth - 1) % 12) + 1;

  // The quarter's start year is the current year unless we have wrapped past December.
  const startYear = startMonth > parts.month ? parts.year - 1 : parts.year;
  const startPeriod = makePeriod(startYear, startMonth);
  const endPeriod = addMonths(startPeriod, 2) ?? startPeriod;

  return {
    index,
    startPeriod,
    endPeriod,
    label: `Q${String(index)} ${financialYearOfPeriod(startPeriod)?.label ?? ''}`.trim(),
  };
}

/**
 * Whether a document belonging to `expected` may still be considered on time when it
 * appears in `actual`, given how often the supplier files.
 *
 * A monthly filer is on time only in the expected period itself. A quarterly (QRMP)
 * filer has until the last month of that quarter, because that is when their GSTR-1 is
 * due -- penalising them for using a scheme the law offers them would be wrong, and is
 * the single fastest way to lose a user's trust in the scorecard.
 */
export function isWithinOnTimeWindow(
  expected: PeriodKey,
  actual: PeriodKey,
  frequency: 'monthly' | 'quarterly',
): boolean {
  if (comparePeriods(actual, expected) < 0) {
    // Arrived early. Unusual, but never late.
    return true;
  }

  if (frequency === 'monthly') {
    return actual === expected;
  }

  const quarter = quarterOfPeriod(expected);
  if (!quarter) return actual === expected;

  return comparePeriods(actual, quarter.endPeriod) <= 0;
}

// ------------------------------------------------------------------ days

function utcMillis(date: DateOnly): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return Date.UTC(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10) - 1,
    Number.parseInt(match[3], 10),
  );
}

/**
 * Whole days from `from` to `to`, negative when `to` is earlier.
 *
 * Both endpoints are built in UTC, so this is pure calendar arithmetic with no
 * daylight-saving or timezone component -- the number of days between two dates on a
 * wall calendar, which is what a deadline countdown means.
 */
export function daysBetween(from: DateOnly, to: DateOnly): number | null {
  const a = utcMillis(from);
  const b = utcMillis(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Every period from `first` to `last` inclusive, in order. */
export function periodRange(first: PeriodKey, last: PeriodKey): PeriodKey[] {
  const span = monthsBetween(first, last);
  if (span === null || span < 0) return [];

  const out: PeriodKey[] = [];
  for (let i = 0; i <= span; i += 1) {
    const period = addMonths(first, i);
    if (period) out.push(period);
  }
  return out;
}
