/**
 * Presentation-only formatters.
 *
 * Nothing here decides anything. Every value passed in has already been computed by the
 * engine; these functions only choose how it is drawn. If a function in this file ever
 * needs a threshold or a weight, it belongs in the engine instead.
 */

const MONTHS = [
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

/**
 * Indian lakh/crore grouping: 1,44,000 rather than 144,000.
 *
 * Deliberately hand-rolled rather than `Intl.NumberFormat('en-IN')`. The Intl output
 * varies between browsers and Node versions, which would make the CSV exports and the
 * screen disagree, and a rupee figure that changes shape depending on where it is read
 * is exactly the sort of thing that costs a report its credibility.
 */
export function formatInr(value: number, options: { decimals?: boolean } = {}): string {
  const negative = value < 0;
  const absolute = Math.abs(value);

  const whole = options.decimals ? Math.floor(absolute) : Math.round(absolute);
  const text = String(whole);

  const last3 = text.slice(-3);
  const rest = text.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;

  const paise = options.decimals
    ? `.${String(Math.round((absolute - whole) * 100)).padStart(2, '0')}`
    : '';

  return `${negative ? '-' : ''}₹${grouped}${paise}`;
}

/** The full-precision form, for the title attribute beside a rounded figure. */
export function formatInrExact(value: number): string {
  return formatInr(value, { decimals: true });
}

/** Large figures in lakh and crore, for the KPI band where space is tight. */
export function formatInrCompact(value: number): { display: string; exact: string } {
  const exact = formatInrExact(value);
  const absolute = Math.abs(value);

  if (absolute >= 10_000_000) {
    return { display: `₹${(value / 10_000_000).toFixed(2)} Cr`, exact };
  }
  if (absolute >= 100_000) {
    return { display: `₹${(value / 100_000).toFixed(2)} L`, exact };
  }
  return { display: formatInr(value), exact };
}

export function formatPercent(value: number | null, decimals = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatMonths(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(1);
}

/** `"2026-04"` becomes `"Apr 2026"`. */
export function formatPeriod(period: string | null): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return '—';
  const year = period.slice(0, 4);
  const month = Number.parseInt(period.slice(5, 7), 10);
  return `${MONTHS[month - 1] ?? '??'} ${year}`;
}

/** `"2026-04-25"` becomes `"25 Apr 2026"`. Never constructs a Date. */
export function formatDate(date: string | null): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '—';
  const year = date.slice(0, 4);
  const month = Number.parseInt(date.slice(5, 7), 10);
  const day = Number.parseInt(date.slice(8, 10), 10);
  return `${String(day)} ${MONTHS[month - 1] ?? '??'} ${year}`;
}

export function formatDays(days: number): string {
  if (days < 0) return `${String(Math.abs(days))} days ago`;
  if (days === 0) return 'today';
  return `${String(days)} days`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}
