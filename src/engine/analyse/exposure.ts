import { roundRupees, totalTax } from '../normalize/money';
import { imsKey } from '../parse/imsLog';
import type {
  BookRow,
  CreditNoteReport,
  HeadlineKpis,
  ImsLogRow,
  MatchResult,
  PeriodKey,
  Portal2bRow,
  SupplierScorecardEntry,
} from '../types';
import type { RecoveryInput } from './supplierScore';

/**
 * Exposure: the money figures, and the credit note handling.
 *
 * Everything here is a sum over results the rest of the engine has already classified.
 * Keeping it in one file means the headline KPIs cannot drift away from the supplier
 * table beneath them -- both are computed from the same numbers, once.
 */

/**
 * Whether a gap eventually resolved.
 *
 * A gap counts as recovered when the same document turns up in a later loaded period.
 * Gaps in the most recent period are still counted as unresolved, which is the known
 * pessimistic bias recorded in ASSUMPTIONS.md: they simply have not had the chance yet.
 */
export function computeRecovery(
  results: readonly MatchResult[],
  periods: readonly PeriodKey[],
): { global: RecoveryInput; bySupplier: Map<string, RecoveryInput> } {
  const global: RecoveryInput = { resolved: 0, recovered: 0 };
  const bySupplier = new Map<string, RecoveryInput>();

  const lastPeriod = periods[periods.length - 1] ?? null;

  for (const result of results) {
    if (!result.inScope) continue;
    if (result.status === 'missing_in_books') continue;

    const expected = result.expectedPeriod;
    if (expected === null) continue;

    // A document whose expected period is the newest one loaded has had no later period
    // in which to appear, so it is not evidence either way.
    if (lastPeriod !== null && expected === lastPeriod) continue;

    const wasGap = result.status === 'missing_in_2b' || result.onTime === false;
    if (!wasGap) continue;

    const recovered = result.actualPeriod !== null && result.taxReceived > 0;

    const key = result.supplierGstin ?? `name:${result.supplierName.toLowerCase()}`;
    const entry = bySupplier.get(key) ?? { resolved: 0, recovered: 0 };
    entry.resolved += 1;
    if (recovered) entry.recovered += 1;
    bySupplier.set(key, entry);

    global.resolved += 1;
    if (recovered) global.recovered += 1;
  }

  return { global, bySupplier };
}

/**
 * Credit notes, tracked entirely separately from invoices.
 *
 * The category that matters is the rejected one. Rejecting a credit note in IMS pushes
 * the liability back onto the *supplier* -- it increases what they owe in their next
 * GSTR-3B. A credit note rejected carelessly, or rejected because nobody recognised the
 * rate difference, quietly hands a supplier a tax bill they will eventually ring up
 * about. That is worth its own panel.
 */
export function buildCreditNoteReport(
  bookRows: readonly BookRow[],
  portalRows: readonly Portal2bRow[],
  imsIndex: Map<string, ImsLogRow>,
): CreditNoteReport {
  const report: CreditNoteReport = {
    total: { count: 0, taxValue: 0 },
    rejected: { count: 0, taxValue: 0, rows: [] },
    accepted: { count: 0, taxValue: 0 },
    pending: { count: 0, taxValue: 0 },
  };

  // Portal credit notes are the ones with a tax consequence for both parties; book-only
  // credit notes are counted in the total so nothing goes missing.
  const seen = new Set<string>();

  const consider = (
    key: string,
    supplierName: string,
    supplierGstin: string | null,
    invoiceNumber: string,
    invoiceDate: string | null,
    taxValue: number,
  ) => {
    if (seen.has(key)) return;
    seen.add(key);

    report.total.count += 1;
    report.total.taxValue = roundRupees(report.total.taxValue + taxValue);

    const ims = imsIndex.get(key);
    if (ims?.action === 'Reject') {
      report.rejected.count += 1;
      report.rejected.taxValue = roundRupees(report.rejected.taxValue + taxValue);
      report.rejected.rows.push({
        supplierName,
        supplierGstin,
        invoiceNumber,
        invoiceDate,
        taxValue,
        remark: ims.remark,
      });
    } else if (ims?.action === 'Accept') {
      report.accepted.count += 1;
      report.accepted.taxValue = roundRupees(report.accepted.taxValue + taxValue);
    } else if (ims?.action === 'Pending') {
      report.pending.count += 1;
      report.pending.taxValue = roundRupees(report.pending.taxValue + taxValue);
    }
  };

  for (const row of portalRows) {
    if (row.docType !== 'credit_note') continue;
    if (row.supersededById !== null) continue;
    consider(
      imsKey(row.supplierGstin, row.invoiceNumberNormalized),
      row.supplierName,
      row.supplierGstin,
      row.invoiceNumber,
      row.invoiceDate,
      totalTax(row.tax),
    );
  }

  for (const row of bookRows) {
    if (row.docType !== 'credit_note') continue;
    consider(
      imsKey(row.supplierGstin, row.invoiceNumberNormalized),
      row.supplierName,
      row.supplierGstin,
      row.invoiceNumber,
      row.invoiceDate,
      totalTax(row.tax),
    );
  }

  report.rejected.rows.sort((a, b) => b.taxValue - a.taxValue);
  return report;
}

/**
 * Credit note trouble attributable to a supplier, for the dispute-rate component.
 *
 * A credit note the buyer rejected is the *buyer's* decision, so it does not count
 * against the supplier here even though it is a high-attention item elsewhere.
 */
export function creditNoteIssueValueBySupplier(
  bookRows: readonly BookRow[],
  portalRows: readonly Portal2bRow[],
): Map<string, number> {
  const bySupplier = new Map<string, number>();

  const bookKeys = new Set(
    bookRows
      .filter((row) => row.docType === 'credit_note')
      .map((row) => imsKey(row.supplierGstin, row.invoiceNumberNormalized)),
  );

  // A credit note the supplier reported that the buyer never recorded: the supplier has
  // reduced the buyer's credit without the buyer agreeing to it.
  for (const row of portalRows) {
    if (row.docType !== 'credit_note' || row.supersededById !== null) continue;
    const key = imsKey(row.supplierGstin, row.invoiceNumberNormalized);
    if (bookKeys.has(key)) continue;

    const supplier = row.supplierGstin ?? `name:${row.supplierName.toLowerCase()}`;
    bySupplier.set(supplier, roundRupees((bySupplier.get(supplier) ?? 0) + totalTax(row.tax)));
  }

  return bySupplier;
}

/** Total in-scope tax across every result. The denominator for concentration. */
export function totalInScopeItcOf(results: readonly MatchResult[]): number {
  return roundRupees(
    results
      .filter((result) => result.inScope && result.status !== 'missing_in_books')
      .reduce((sum, result) => sum + result.taxReceived + result.taxAtRisk, 0),
  );
}

export function buildHeadlineKpis(
  suppliers: readonly SupplierScorecardEntry[],
  totalInScopeItc: number,
  deemedAcceptedCount: number,
  deemedAcceptedShare: number,
): HeadlineKpis {
  return {
    totalItcAtRisk: roundRupees(suppliers.reduce((sum, s) => sum + s.itcAtRisk, 0)),
    expectedCashLoss: roundRupees(suppliers.reduce((sum, s) => sum + s.expectedCashLoss, 0)),
    redSupplierCount: suppliers.filter((s) => s.flag === 'red').length,
    deemedAcceptedShare,
    deemedAcceptedCount,
    totalInScopeItc,
    suppliersScored: suppliers.filter((s) => s.score !== null).length,
    suppliersInsufficientHistory: suppliers.filter((s) => s.flag === 'insufficient_history').length,
  };
}
