import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { PARSING } from '../config';
import { asText } from '../normalize/text';
import { levenshtein } from '../normalize/invoiceNumber';
import type { FieldMapping } from '../types';

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
  /**
   * Header spellings that identify this field confidently, **best first**.
   *
   * Order is meaningful: when a file contains more than one of these, the earliest in
   * this list wins, whatever order the columns appear in.
   */
  synonyms: string[];
  /**
   * Spellings that usually mean this field but sometimes mean something else.
   *
   * Only considered once no primary synonym matches, and never reported as an exact
   * match -- `Voucher No.` is a register's own numbering, not the supplier's, so a file
   * offering nothing better deserves a second look rather than silent confidence.
   */
  fallbackSynonyms?: string[];
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
 * How good a candidate column is for a field. Lower is better.
 *
 * The bands are kept far apart so a primary synonym at any position always beats a
 * fallback, and any fallback always beats an edit-distance guess. Within a band the
 * offset is the synonym's own position, which is why the synonym lists are written
 * best-first.
 */
const PRIMARY_BAND = 0;
const FALLBACK_BAND = 1000;
const FUZZY_BAND = 2000;

type CandidateKind = 'primary' | 'fallback' | 'fuzzy';

interface HeaderCandidate {
  raw: string;
  rank: number;
  kind: CandidateKind;
}

/** Every column that could plausibly be this field, best first. */
function candidatesFor(
  spec: FieldSpec,
  headers: ReadonlyArray<{ raw: string; key: string }>,
  claimed: ReadonlySet<string>,
  /**
   * Header spellings that name some *other* field exactly.
   *
   * These are excluded from edit-distance matching, which otherwise produces confident
   * nonsense: `SGST` is one character from `cgst`, so without this the SGST column
   * registers as a candidate for CGST. A column that already names another field
   * precisely is not a near-miss for this one.
   */
  namedByOtherFields: ReadonlySet<string>,
): HeaderCandidate[] {
  const primary = spec.synonyms.map(normalizeHeader);
  const fallback = (spec.fallbackSynonyms ?? []).map(normalizeHeader);

  const candidates: HeaderCandidate[] = [];

  for (const header of headers) {
    if (header.key === '' || claimed.has(header.raw)) continue;

    const primaryIndex = primary.indexOf(header.key);
    if (primaryIndex >= 0) {
      candidates.push({ raw: header.raw, rank: PRIMARY_BAND + primaryIndex, kind: 'primary' });
      continue;
    }

    const fallbackIndex = fallback.indexOf(header.key);
    if (fallbackIndex >= 0) {
      candidates.push({ raw: header.raw, rank: FALLBACK_BAND + fallbackIndex, kind: 'fallback' });
      continue;
    }

    if (namedByOtherFields.has(header.key)) continue;

    // Edit distance against every spelling, primary and fallback alike.
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const synonym of [...primary, ...fallback]) {
      const distance = levenshtein(header.key, synonym, PARSING.headerFuzzyMaxDistance);
      if (distance < bestDistance) bestDistance = distance;
    }
    if (bestDistance <= PARSING.headerFuzzyMaxDistance) {
      candidates.push({ raw: header.raw, rank: FUZZY_BAND + bestDistance, kind: 'fuzzy' });
    }
  }

  // Rank first, then file order, so the result never depends on object iteration order.
  return candidates.sort((a, b) => a.rank - b.rank);
}

/**
 * Matches file headers to engine fields.
 *
 * The rule that matters: a field takes the column matching its *best* spelling, not the
 * first column that happens to match any of them. A Tally register listing `Voucher No.`
 * before `Invoice No.` used to hand the buyer's internal voucher number to the matcher
 * and label it "Exact" -- after which no invoice could ever be found in GSTR-2B, every
 * tier-1 and tier-4 match silently vanished, and the IMS join failed too. Nothing about
 * the output looked wrong; it was simply built on the wrong column.
 *
 * Fields are resolved in order of how well they matched rather than the order they are
 * declared, so a field with an unambiguous primary match claims its column before a
 * weaker field can take it by being listed first.
 */
export function autoMapFields(
  headers: readonly string[],
  specs: readonly FieldSpec[],
): FieldMapping[] {
  const normalizedHeaders = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));
  const claimed = new Set<string>();
  const resolved = new Map<string, FieldMapping>();

  const remaining = new Set(specs.map((spec) => spec.field));
  const specByField = new Map(specs.map((spec) => [spec.field, spec]));

  while (remaining.size > 0) {
    // Of everything still unresolved, settle the field with the strongest claim first.
    let chosenField: string | null = null;
    let chosenCandidates: HeaderCandidate[] = [];
    let chosenRank = Number.POSITIVE_INFINITY;

    for (const field of remaining) {
      const spec = specByField.get(field);
      if (!spec) continue;

      const namedByOtherFields = new Set(
        specs
          .filter((other) => other.field !== field)
          .flatMap((other) => other.synonyms.map(normalizeHeader)),
      );

      const candidates = candidatesFor(spec, normalizedHeaders, claimed, namedByOtherFields);
      const best = candidates[0];
      if (best && best.rank < chosenRank) {
        chosenRank = best.rank;
        chosenField = field;
        chosenCandidates = candidates;
      }
    }

    // Nothing left has any candidate: everything still unresolved is unmapped.
    if (chosenField === null) break;

    const spec = specByField.get(chosenField);
    const best = chosenCandidates[0];
    if (!spec || !best) break;

    remaining.delete(chosenField);
    claimed.add(best.raw);

    resolved.set(chosenField, {
      field: spec.field,
      label: spec.label,
      sourceHeader: best.raw,
      /*
       * Only a primary spelling earns "Exact". A fallback such as `Voucher No.`, or a
       * near-miss caught by edit distance, is a guess and is labelled as one -- the old
       * behaviour called both of those exact, which is precisely how a wrong column got
       * through unquestioned.
       */
      confidence: best.kind === 'primary' ? 'exact' : 'fuzzy',
      required: spec.required,
      hint: spec.hint,
      alternatives: chosenCandidates.slice(1).map((candidate) => candidate.raw),
    });
  }

  return specs.map(
    (spec) =>
      resolved.get(spec.field) ?? {
        field: spec.field,
        label: spec.label,
        sourceHeader: null,
        confidence: 'none',
        required: spec.required,
        hint: spec.hint,
        alternatives: [],
      },
  );
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
