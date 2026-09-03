import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { PARSING } from '../config';
import { asText } from '../normalize/text';
import { levenshtein } from '../normalize/invoiceNumber';
import type { FieldMapping, MappingConfidence } from '../types';

/**
 * Generic reader for the spreadsheets people actually have.
 *
 * A Tally export is not a clean table. It has a company name in row 1, a date range in
 * row 2, a blank row, merged cells across the title, the real column headers somewhere
 * around row 5, and a "Grand Total" row at the bottom. A parser that assumes row 1 is
 * the header fails on the first real file it meets, so this one goes looking for the
 * header instead, and reports where it decided the header was so the user can correct it.
 */

export interface RawSheet {
  name: string;
  /** Every row as an array of raw cell values, in file order. */
  rows: unknown[][];
}

export interface RawWorkbook {
  fileName: string;
  sheets: RawSheet[];
}

/** Reads CSV text or an Excel workbook into raw rows. No interpretation yet. */
export function readWorkbook(content: ArrayBuffer | string, fileName: string): RawWorkbook {
  if (typeof content === 'string') {
    const parsed = Papa.parse<unknown[]>(content, {
      header: false,
      // Empty lines are kept so that a row number in this file still matches the row
      // number the user sees in their spreadsheet.
      skipEmptyLines: false,
      dynamicTyping: false,
    });

    return {
      fileName,
      sheets: [{ name: fileName, rows: parsed.data.filter(Array.isArray) }],
    };
  }

  const workbook = XLSX.read(content, {
    type: 'array',
    // Dates as real Date objects rather than serials where the cell is formatted as a
    // date; parseDateOnly reads them in UTC.
    cellDates: true,
    cellNF: false,
    cellText: false,
  });

  const sheets: RawSheet[] = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return { name, rows: [] };

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });

    return { name, rows: rows.filter(Array.isArray) };
  });

  return { fileName, sheets };
}

/** Lowercases and strips everything that varies between two spellings of one header. */
export function normalizeHeader(value: unknown): string {
  return asText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export interface FieldSpec {
  /** Canonical engine field name. */
  field: string;
  label: string;
  hint: string;
  required: boolean;
  /** Header spellings seen in real exports. Compared after `normalizeHeader`. */
  synonyms: string[];
}

export interface HeaderDetection {
  headerRowIndex: number;
  headers: string[];
  /** Share of the specs that found a header in this row. Drives the confidence shown. */
  hitRate: number;
}

/**
 * Finds the row that holds the column names.
 *
 * Scores each candidate row by how many known field synonyms it contains, and takes the
 * best. A title row scores zero because "ABC Traders Private Limited" matches no field
 * name, which is exactly what distinguishes it from a header row.
 */
export function detectHeaderRow(rows: readonly unknown[][], specs: readonly FieldSpec[]): HeaderDetection {
  const synonymSet = new Set<string>();
  for (const spec of specs) {
    for (const synonym of spec.synonyms) synonymSet.add(normalizeHeader(synonym));
  }

  let best: HeaderDetection = { headerRowIndex: 0, headers: [], hitRate: 0 };
  const limit = Math.min(rows.length, PARSING.maxHeaderSearchRows);

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (!row) continue;

    const headers = row.map((cell) => asText(cell).trim());
    const nonEmpty = headers.filter((h) => h !== '');
    if (nonEmpty.length === 0) continue;

    let hits = 0;
    for (const header of nonEmpty) {
      if (synonymSet.has(normalizeHeader(header))) hits += 1;
    }

    // Measured against the number of fields we hoped to find, not the row width: a
    // sheet with thirty columns should not be penalised for having extra ones.
    const hitRate = hits / specs.length;
    if (hitRate > best.hitRate) {
      best = { headerRowIndex: i, headers, hitRate };
    }
  }

  // Nothing looked like a header. Fall back to the first non-empty row and let the
  // mapping screen sort it out -- with a hit rate of 0, the UI shows every field as
  // unmapped rather than pretending it understood the file.
  if (best.hitRate < PARSING.headerDetectionMinHitRate) {
    const firstNonEmptyIndex = rows.findIndex(
      (row) => row && row.some((cell) => asText(cell).trim() !== ''),
    );
    const index = firstNonEmptyIndex < 0 ? 0 : firstNonEmptyIndex;
    return {
      headerRowIndex: index,
      headers: (rows[index] ?? []).map((cell) => asText(cell).trim()),
      hitRate: best.hitRate,
    };
  }

  return best;
}

/**
 * Matches file headers to engine fields, exactly where possible and by edit distance
 * otherwise.
 *
 * Fuzzy matching is deliberately conservative and always reports its confidence,
 * because the mapping screen exists precisely so a wrong guess can be corrected by the
 * person who knows what the column means.
 */
export function autoMapFields(
  headers: readonly string[],
  specs: readonly FieldSpec[],
): FieldMapping[] {
  const normalizedHeaders = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const claimed = new Set<string>();

  const exactPass: Array<FieldMapping | null> = specs.map(() => null);

  // Exact matches first, so a fuzzy near-miss can never steal a header that some other
  // field names precisely.
  specs.forEach((spec, index) => {
    const synonymKeys = spec.synonyms.map(normalizeHeader);
    const hit = normalizedHeaders.find(
      (h) => h.key !== '' && !claimed.has(h.raw) && synonymKeys.includes(h.key),
    );
    if (hit) {
      claimed.add(hit.raw);
      exactPass[index] = {
        field: spec.field,
        label: spec.label,
        sourceHeader: hit.raw,
        confidence: 'exact',
        required: spec.required,
        hint: spec.hint,
      };
    }
  });

  return specs.map((spec, index) => {
    const already = exactPass[index];
    if (already) return already;

    const synonymKeys = spec.synonyms.map(normalizeHeader);
    let bestHeader: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const header of normalizedHeaders) {
      if (header.key === '' || claimed.has(header.raw)) continue;
      for (const synonym of synonymKeys) {
        const distance = levenshtein(header.key, synonym, PARSING.headerFuzzyMaxDistance);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestHeader = header.raw;
        }
      }
    }

    const confidence: MappingConfidence =
      bestHeader !== null && bestDistance <= PARSING.headerFuzzyMaxDistance ? 'fuzzy' : 'none';

    if (confidence === 'fuzzy' && bestHeader !== null) claimed.add(bestHeader);

    return {
      field: spec.field,
      label: spec.label,
      sourceHeader: confidence === 'none' ? null : bestHeader,
      confidence,
      required: spec.required,
      hint: spec.hint,
    };
  });
}

export interface SheetRow {
  /** 1-based row number in the original file, for Data Health to point at. */
  sourceRow: number;
  /** Cells keyed by the file's own header text. */
  cells: Record<string, unknown>;
}

/** Turns raw rows below the header into objects keyed by the file's header text. */
export function toSheetRows(
  rows: readonly unknown[][],
  headerRowIndex: number,
  headers: readonly string[],
): SheetRow[] {
  const out: SheetRow[] = [];

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;

    // Skip rows that are entirely empty; they carry no information and would otherwise
    // become phantom invoices.
    if (!row.some((cell) => asText(cell).trim() !== '')) continue;

    const cells: Record<string, unknown> = {};
    headers.forEach((header, column) => {
      if (header === '') return;
      cells[header] = row[column] ?? null;
    });

    out.push({ sourceRow: i + 1, cells });
  }

  return out;
}

/** Reads one mapped field out of a row, or null when the field is unmapped. */
export function cellOf(row: SheetRow, mapping: readonly FieldMapping[], field: string): unknown {
  const entry = mapping.find((m) => m.field === field);
  if (!entry?.sourceHeader) return null;
  return row.cells[entry.sourceHeader] ?? null;
}

/** Text form of a mapped field, trimmed. Empty string when absent. */
export function textOf(row: SheetRow, mapping: readonly FieldMapping[], field: string): string {
  const value = cellOf(row, mapping, field);
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return asText(value).trim();
}

/**
 * A "Grand Total" or "Total" line at the foot of a Tally export is a summary, not a
 * document. Left in, it would appear as an enormous phantom invoice with no number.
 */
export function looksLikeTotalRow(row: SheetRow): boolean {
  const values = Object.values(row.cells)
    .map((cell) => asText(cell).trim().toLowerCase())
    .filter((text) => text !== '');

  if (values.length === 0) return false;

  const textValues = values.filter((text) => !/^[\d,.()₹ -]+$/.test(text));
  if (textValues.length === 0) return false;

  return textValues.every(
    (text) =>
      text === 'total' ||
      text === 'grand total' ||
      text === 'sub total' ||
      text === 'subtotal' ||
      text.startsWith('total '),
  );
}
