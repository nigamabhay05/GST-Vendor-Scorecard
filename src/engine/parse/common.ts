import { PARSING } from '../config';
import { asText } from '../normalize/text';
import type {
  AmbiguousDateColumn,
  FieldMapping,
  FileKind,
  GstinIssue,
  SlashDateFormatAnswers,
} from '../types';
import { analyseDateColumn, type SlashDateFormat } from '../validate/dates';
import type { GstinValidation } from '../validate/gstin';
import type { SheetRow } from './csvExcel';

/** Plumbing shared by all four parsers. Business rules live in the parsers themselves. */

export function excerptOf(cells: Record<string, unknown>): string {
  return Object.values(cells)
    .map((cell) => asText(cell).trim())
    .filter((text) => text !== '')
    .slice(0, 4)
    .join(' | ')
    .slice(0, 160);
}

export function previewOf(rows: readonly SheetRow[]): Array<Record<string, string>> {
  return rows.slice(0, PARSING.previewRows).map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.cells)) {
      out[key] = value instanceof Date ? value.toISOString().slice(0, 10) : asText(value);
    }
    return out;
  });
}

export interface ResolvedDateColumn {
  header: string | null;
  /** The format to read the column with, or null when the user still has to say. */
  hint: SlashDateFormat | null;
  /** Present only when the user must be asked before results can be trusted. */
  ambiguous: AmbiguousDateColumn | null;
}

/**
 * Settles a date column's format once for the whole file, before any row is read.
 *
 * Doing this per column rather than per cell is what lets one unambiguous value such as
 * `25/04/2026` fix the reading of every ambiguous `05/04/2026` elsewhere in the same
 * column. Only when the column proves nothing either way is the user asked.
 */
export function resolveDateColumn(
  kind: FileKind,
  fileName: string,
  fields: readonly FieldMapping[],
  rows: readonly SheetRow[],
  field: string,
  fallbackLabel: string,
  answers: SlashDateFormatAnswers | undefined,
): ResolvedDateColumn {
  const header = fields.find((f) => f.field === field)?.sourceHeader ?? null;
  const values = header ? rows.map((row) => row.cells[header] ?? null) : [];
  const analysis = analyseDateColumn(values);

  const column = header ?? fallbackLabel;
  const answered = answers?.[`${fileName}::${column}`] ?? null;

  return {
    header,
    hint: analysis.resolved ?? answered,
    ambiguous:
      analysis.ambiguous && answered === null
        ? {
            kind,
            fileName,
            column,
            sampleValues: analysis.samples,
            affectedRows: analysis.evidence.undecidable,
            resolvedAs: null,
          }
        : null,
  };
}

/**
 * Turns a GSTIN validation into a Data Health issue, or null when there is nothing to
 * report. A failed check digit is a warning here, never a reason to drop the row.
 */
export function gstinIssueOf(
  kind: FileKind,
  fileName: string,
  sourceRow: number,
  supplierName: string,
  rawValue: string,
  validation: GstinValidation,
): GstinIssue | null {
  const base = { kind, fileName, sourceRow, supplierName };

  if (validation.blank) {
    return { ...base, value: rawValue, problem: 'blank' };
  }
  if (!validation.formatValid) {
    return { ...base, value: validation.normalized ?? rawValue, problem: 'malformed' };
  }
  if (validation.checkDigitValid === false) {
    return { ...base, value: validation.normalized ?? rawValue, problem: 'check_digit' };
  }
  return null;
}
