import { DATES } from '../config';
import type { DateOnly } from '../types';
import { asText } from '../normalize/text';

/**
 * Date parsing for spreadsheet cells.
 *
 * Two rules govern this file.
 *
 * 1. No `Date` object ever leaks out. Every result is a `"YYYY-MM-DD"` string, and every
 *    intermediate `Date` is built and read in UTC. A timezone shift that moves an
 *    invoice dated 31 March to 30 March moves it into the previous financial year,
 *    which changes its section 16(4) deadline by a full twelve months.
 *
 * 2. When `DD/MM` and `MM/DD` cannot be told apart, the engine stops and asks. It does
 *    not guess, and it does not quietly pick the more common one. A column read the
 *    wrong way round silently corrupts every delay figure in the report, and the user
 *    would have no way to detect it from the output.
 */

export type SlashDateFormat = 'DMY' | 'MDY';

export type DateProblem = 'blank' | 'unparseable' | 'ambiguous';

export interface DateParse {
  value: DateOnly | null;
  raw: string;
  problem: DateProblem | null;
}

const BLANK_TOKENS = new Set(['', '-', '--', 'nil', 'na', 'n/a', 'null', 'undefined']);

/** Plausible Excel serial range: 1900-03-01 to 2099-12-31. Anything else is not a date. */
const MIN_EXCEL_SERIAL = 61;
const MAX_EXCEL_SERIAL = 73050;

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

export function toDateOnly(year: number, month: number, day: number): DateOnly {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** True when the triple is a real calendar date (rejects 31 February and friends). */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (year < 1900 || year > 2199) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Converts an Excel serial number to a date.
 *
 * The offset accounts for Excel's deliberate 1900 leap-year bug. Serials below 61 fall
 * inside the buggy window (January and February 1900) and are rejected rather than
 * silently shifted -- no GST document carries such a date anyway.
 */
export function fromExcelSerial(serial: number): DateOnly | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole < MIN_EXCEL_SERIAL || whole > MAX_EXCEL_SERIAL) return null;

  const ms = (whole - DATES.excelEpochUtcDays) * 86_400_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;

  return toDateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Expands a two-digit year the way every Indian accounting package does. */
function expandYear(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (raw.length === 4) return n;
  if (raw.length === 2) return n < 50 ? 2000 + n : 1900 + n;
  return Number.NaN;
}

interface SplitDate {
  first: number;
  second: number;
  year: number;
}

/** Splits `DD/MM/YYYY`-shaped text into its three parts, whatever the separator. */
function splitSlashDate(text: string): SplitDate | null {
  const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(text);
  if (!match?.[1] || !match[2] || !match[3]) return null;

  const first = Number.parseInt(match[1], 10);
  const second = Number.parseInt(match[2], 10);
  const year = expandYear(match[3]);
  if (!Number.isFinite(year)) return null;

  return { first, second, year };
}

/**
 * Whether a `d/m/y`-shaped value settles its own format.
 *
 *   - a first component above 12 can only be a day  -> DMY
 *   - a second component above 12 can only be a day -> MDY
 *   - both at or below 12                           -> undecidable from this value alone
 */
function evidenceOf(split: SplitDate): SlashDateFormat | 'either' {
  if (split.first > 12 && split.second <= 12) return 'DMY';
  if (split.second > 12 && split.first <= 12) return 'MDY';
  return 'either';
}

export interface DateColumnAnalysis {
  /** The format the column's own contents prove. Null when nothing proves one. */
  resolved: SlashDateFormat | null;
  /** True when the user must be asked before the column can be trusted. */
  ambiguous: boolean;
  evidence: {
    provesDmy: number;
    provesMdy: number;
    undecidable: number;
    unambiguousIso: number;
    nonDate: number;
  };
  /** A few real values from the column, to show the user what they are deciding about. */
  samples: string[];
}

/**
 * Decides a whole column's date format from all of its values at once.
 *
 * Format is a property of a column, not of a cell: one value of `13/04/2026` proves the
 * entire column is `DD/MM`, and that settles the reading of `05/04/2026` twelve rows
 * further down. Only when no value anywhere in the column resolves it is the user asked.
 */
export function analyseDateColumn(values: readonly unknown[]): DateColumnAnalysis {
  const evidence = {
    provesDmy: 0,
    provesMdy: 0,
    undecidable: 0,
    unambiguousIso: 0,
    nonDate: 0,
  };
  const samples: string[] = [];

  for (const value of values) {
    if (value instanceof Date) {
      evidence.unambiguousIso += 1;
      continue;
    }
    if (typeof value === 'number') {
      evidence.unambiguousIso += 1;
      continue;
    }

    const text = asText(value).trim();
    if (BLANK_TOKENS.has(text.toLowerCase())) continue;

    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(text)) {
      evidence.unambiguousIso += 1;
      continue;
    }

    const split = splitSlashDate(text);
    if (!split) {
      evidence.nonDate += 1;
      continue;
    }

    if (samples.length < 5) samples.push(text);

    const verdict = evidenceOf(split);
    if (verdict === 'DMY') evidence.provesDmy += 1;
    else if (verdict === 'MDY') evidence.provesMdy += 1;
    else evidence.undecidable += 1;
  }

  const slashValues = evidence.provesDmy + evidence.provesMdy + evidence.undecidable;

  // No slash-formatted values at all: nothing to disambiguate.
  if (slashValues === 0) {
    return { resolved: null, ambiguous: false, evidence, samples };
  }

  // Both readings are proven somewhere in the same column, so the column is not
  // internally consistent. Asking is the only safe move.
  if (evidence.provesDmy > 0 && evidence.provesMdy > 0) {
    return { resolved: null, ambiguous: true, evidence, samples };
  }

  if (evidence.provesDmy > 0) return { resolved: 'DMY', ambiguous: false, evidence, samples };
  if (evidence.provesMdy > 0) return { resolved: 'MDY', ambiguous: false, evidence, samples };

  // Every value works read either way. This is the case the brief insists must stop and
  // ask rather than guess.
  return { resolved: null, ambiguous: true, evidence, samples };
}

/**
 * Parses one cell into a date-only string.
 *
 * `hint` supplies the column's resolved format -- either proven by `analyseDateColumn`
 * or answered by the user. Without it, a genuinely ambiguous value returns the
 * `ambiguous` problem rather than a date.
 */
export function parseDateOnly(raw: unknown, hint?: SlashDateFormat | null): DateParse {
  if (raw === null || raw === undefined) {
    return { value: null, raw: '', problem: 'blank' };
  }

  // SheetJS returns real Date objects when cellDates is on. Read them in UTC only.
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      return { value: null, raw: String(raw), problem: 'unparseable' };
    }
    return {
      value: toDateOnly(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate()),
      raw: raw.toISOString(),
      problem: null,
    };
  }

  if (typeof raw === 'number') {
    const value = fromExcelSerial(raw);
    return value
      ? { value, raw: String(raw), problem: null }
      : { value: null, raw: String(raw), problem: 'unparseable' };
  }

  const rawText = asText(raw);
  const text = rawText.trim();

  if (BLANK_TOKENS.has(text.toLowerCase())) {
    return { value: null, raw: rawText, problem: 'blank' };
  }

  // ISO, with or without a time component. The time is discarded, never applied.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  if (iso?.[1] && iso[2] && iso[3]) {
    const year = Number.parseInt(iso[1], 10);
    const month = Number.parseInt(iso[2], 10);
    const day = Number.parseInt(iso[3], 10);
    return isRealDate(year, month, day)
      ? { value: toDateOnly(year, month, day), raw: rawText, problem: null }
      : { value: null, raw: rawText, problem: 'unparseable' };
  }

  // A bare integer stored as text, in the Excel serial range.
  if (/^\d+$/.test(text)) {
    const serial = Number.parseInt(text, 10);
    const value = fromExcelSerial(serial);
    if (value) return { value, raw: rawText, problem: null };
    return { value: null, raw: rawText, problem: 'unparseable' };
  }

  const split = splitSlashDate(text);
  if (!split) {
    return { value: null, raw: rawText, problem: 'unparseable' };
  }

  const verdict = evidenceOf(split);
  const format: SlashDateFormat | null = verdict === 'either' ? (hint ?? null) : verdict;

  if (format === null) {
    // Undecidable and nobody has told us which way to read it.
    return { value: null, raw: rawText, problem: 'ambiguous' };
  }

  const day = format === 'DMY' ? split.first : split.second;
  const month = format === 'DMY' ? split.second : split.first;

  return isRealDate(split.year, month, day)
    ? { value: toDateOnly(split.year, month, day), raw: rawText, problem: null }
    : { value: null, raw: rawText, problem: 'unparseable' };
}
