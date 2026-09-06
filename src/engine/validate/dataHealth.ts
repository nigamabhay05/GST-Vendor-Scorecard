import { findNormalizationCollisions } from '../normalize/invoiceNumber';
import { roundRupees, totalTax } from '../normalize/money';
import type {
  AmbiguousColumnMapping,
  BookRow,
  DataHealthReport,
  DuplicateInvoiceGroup,
  FileMapping,
  NormalizationCollision,
  ParseOutcome,
  Portal2bRow,
  ScopeExclusionReason,
  ScopeExclusionSummary,
} from '../types';

/**
 * The Data Health report.
 *
 * This is where the project proves it can handle real books rather than textbook data.
 * Every row that was dropped, every GSTIN that failed its check digit, every date the
 * engine refused to guess at is listed with the row number it came from. Nothing
 * disappears silently, because a figure the user cannot trace is a figure they cannot
 * defend to a client.
 */

/** Groups documents by supplier, using GSTIN where present and the name otherwise. */
export function supplierKeyOf(gstin: string | null, name: string): string {
  if (gstin) return gstin;
  const nameKey = name.trim().toLowerCase();
  return nameKey === '' ? 'unknown-supplier' : `name:${nameKey}`;
}

/**
 * Finds invoice numbers that normalisation collapsed onto one key despite being
 * genuinely different documents.
 *
 * Scoped to one supplier within one period, which is the only place a collision can do
 * real harm: two suppliers using the same invoice number is normal and harmless, since
 * matching is always keyed by supplier as well.
 */
export function findBookCollisions(rows: readonly BookRow[]): NormalizationCollision[] {
  const groups = new Map<string, BookRow[]>();

  for (const row of rows) {
    const key = `${supplierKeyOf(row.supplierGstin, row.supplierName)}|${row.period}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const collisions: NormalizationCollision[] = [];

  for (const group of groups.values()) {
    const found = findNormalizationCollisions(
      group,
      (row) => row.invoiceNumberNormalized,
      (row) => row.invoiceNumber,
    );

    for (const collision of found) {
      const first = collision.members[0];
      if (!first) continue;

      collisions.push({
        supplierGstin: first.supplierGstin,
        supplierName: first.supplierName,
        period: first.period,
        normalizedKey: collision.normalizedKey,
        originalInvoiceNumbers: collision.members.map((m) => m.invoiceNumber),
        rowIds: collision.members.map((m) => m.id),
      });
    }
  }

  collisions.sort(
    (a, b) =>
      a.period.localeCompare(b.period) || a.normalizedKey.localeCompare(b.normalizedKey),
  );
  return collisions;
}

/**
 * The same invoice number recorded twice for one supplier.
 *
 * Distinct from a normalisation collision: this is one document entered twice, which
 * inflates purchases and will produce a phantom gap when only one copy matches. Whether
 * the values agree is reported too, since two rows with the same number and different
 * values is usually a revision rather than a duplicate.
 */
export function findDuplicateInvoices(rows: readonly BookRow[]): DuplicateInvoiceGroup[] {
  const groups = new Map<string, BookRow[]>();

  for (const row of rows) {
    if (row.invoiceNumberNormalized === '') continue;
    const key = `${supplierKeyOf(row.supplierGstin, row.supplierName)}|${row.invoiceNumberNormalized}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const duplicates: DuplicateInvoiceGroup[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Only rows whose original numbers agree are duplicates; differing originals are a
    // normalisation collision, reported separately.
    const distinctOriginals = new Set(
      group.map((row) => row.invoiceNumber.trim().toUpperCase()),
    );
    if (distinctOriginals.size > 1) continue;

    const first = group[0];
    if (!first) continue;

    const values = group.map((row) => totalTax(row.tax) + row.tax.taxable);
    const identicalValues = values.every((value) => Math.abs(value - (values[0] ?? 0)) < 0.01);

    duplicates.push({
      kind: 'purchaseRegister',
      supplierGstin: first.supplierGstin,
      supplierName: first.supplierName,
      invoiceNumber: first.invoiceNumber,
      rowIds: group.map((row) => row.id),
      identicalValues,
    });
  }

  duplicates.sort(
    (a, b) =>
      a.supplierName.localeCompare(b.supplierName) ||
      a.invoiceNumber.localeCompare(b.invoiceNumber),
  );
  return duplicates;
}

/** Totals the documents excluded from at-risk figures, by the reason they were excluded. */
export function summariseScopeExclusions(rows: readonly BookRow[]): ScopeExclusionSummary[] {
  const totals = new Map<ScopeExclusionReason, ScopeExclusionSummary>();

  for (const row of rows) {
    if (row.scope.inScope || row.scope.reason === null) continue;

    const existing = totals.get(row.scope.reason) ?? {
      reason: row.scope.reason,
      rows: 0,
      taxableValue: 0,
      taxValue: 0,
    };

    existing.rows += 1;
    existing.taxableValue = roundRupees(existing.taxableValue + row.tax.taxable);
    existing.taxValue = roundRupees(existing.taxValue + totalTax(row.tax));
    totals.set(row.scope.reason, existing);
  }

  return [...totals.values()].sort((a, b) => b.taxValue - a.taxValue);
}

/**
 * Fields where more than one column in the file could have been the source.
 *
 * This is reported even when the engine is confident it chose correctly, because the
 * failure mode is invisible. A register offering both `Voucher No.` and `Invoice No.`
 * will analyse cleanly whichever is picked -- but pick the voucher number and nothing
 * will ever match GSTR-2B, since the portal carries the supplier's number. The user is
 * the only one who can confirm which column is which.
 */
export function findAmbiguousColumnMappings(
  mappings: readonly FileMapping[],
): AmbiguousColumnMapping[] {
  const ambiguous: AmbiguousColumnMapping[] = [];

  for (const mapping of mappings) {
    for (const field of mapping.fields) {
      if (field.sourceHeader === null || field.alternatives.length === 0) continue;

      ambiguous.push({
        kind: mapping.kind,
        fileName: mapping.fileName,
        field: field.field,
        label: field.label,
        chosenHeader: field.sourceHeader,
        alternatives: [...field.alternatives],
      });
    }
  }

  return ambiguous;
}

export interface DataHealthInput {
  outcomes: ReadonlyArray<ParseOutcome<BookRow> | ParseOutcome<Portal2bRow> | ParseOutcome<unknown>>;
  bookRows: readonly BookRow[];
}

export function buildDataHealthReport(input: DataHealthInput): DataHealthReport {
  const ambiguousDateColumns = input.outcomes.flatMap((o) => o.ambiguousDateColumns);

  return {
    files: input.outcomes.map((o) => o.summary),
    gstinIssues: input.outcomes.flatMap((o) => o.gstinIssues),
    unparseableDates: input.outcomes.flatMap((o) => o.unparseableDates),
    ambiguousDateColumns,
    ambiguousColumnMappings: findAmbiguousColumnMappings(
      input.outcomes.map((outcome) => outcome.mapping),
    ),
    normalizationCollisions: findBookCollisions(input.bookRows),
    duplicateInvoices: findDuplicateInvoices(input.bookRows),
    scopeExclusions: summariseScopeExclusions(input.bookRows),
    droppedRows: input.outcomes.flatMap((o) => o.droppedRows),

    /*
     * An unresolved ambiguous date column blocks the results rather than merely warning
     * about them. Reading a column the wrong way round corrupts every delay figure and
     * every period assignment downstream, and -- unlike a bad GSTIN -- the corruption is
     * invisible in the output. There is nothing safe to show until the user answers.
     */
    blocking: ambiguousDateColumns.some((column) => column.resolvedAs === null),
  };
}
