/**
 * Safe conversion of a spreadsheet cell to text.
 *
 * A cell arrives as `unknown` and is usually a string, a number or a Date, but a
 * workbook can also hand back an error object or a formula record. Calling `String()`
 * on one of those yields the literal text `[object Object]`, which would then be
 * treated as a supplier name, matched against, and printed in a report. An empty string
 * is the honest answer: the cell held nothing this tool can read.
 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  return '';
}

/** `asText`, trimmed. The form nearly every caller wants. */
export function asTrimmedText(value: unknown): string {
  return asText(value).trim();
}
