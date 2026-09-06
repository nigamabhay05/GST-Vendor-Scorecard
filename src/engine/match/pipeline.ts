import { MATCHING } from '../config';
import { isTaxHeadMismatch, roundRupees, taxHeadOf, totalTax } from '../normalize/money';
import {
  comparePeriods,
  isWithinOnTimeWindow,
  monthsBetween,
  periodFromDate,
  quarterOfPeriod,
} from '../normalize/period';
import type {
  BookRow,
  CreditTreatment,
  FilingFrequency,
  MatchResult,
  MatchStatus,
  MatchTier,
  PeriodKey,
  Portal2bRow,
} from '../types';
import { TIERS, invoiceNumberDistance, isMatchableDocument } from './tiers';

/**
 * The matching pipeline.
 *
 * Three properties matter more than cleverness here, because a chartered accountant has
 * to be able to defend the output:
 *
 *   Deterministic. Both sides are sorted before every tier, so the same input always
 *   produces byte-identical output. A reconciliation that shuffles between runs is
 *   worthless as evidence.
 *
 *   Strictly one-to-one. Once a book row or a 2B row has been matched it is consumed and
 *   cannot match again. Without this, one 2B row could satisfy three book rows and the
 *   report would claim credit that does not exist.
 *
 *   Tiered in strict order. Every tier is tried across the whole dataset before the next
 *   begins, so a certain tier-1 match is never lost to a speculative tier-5 one
 *   elsewhere in the file.
 */

const STATUS_BY_TIER: Record<MatchTier, MatchStatus> = {
  1: 'matched',
  2: 'value_mismatch',
  3: 'invoice_number_mismatch',
  4: 'gstin_state_mismatch',
  5: 'probable_match',
};

/** Decided once, here, from the tier lists in config.ts. */
export function creditTreatmentForTier(tier: MatchTier): CreditTreatment {
  if ((MATCHING.tiersCountedAsReceived as readonly number[]).includes(tier)) return 'received';
  if ((MATCHING.tiersCountedAsPartial as readonly number[]).includes(tier)) return 'partial';
  return 'needs_correction';
}

/** Sort key that fully orders rows, so ties never depend on input order. */
function bookSortKey(row: BookRow): string {
  return [
    row.supplierGstin ?? 'zzz',
    row.invoiceNumberNormalized,
    row.invoiceDate ?? '9999-99-99',
    totalTax(row.tax).toFixed(2).padStart(16, '0'),
    row.id,
  ].join('|');
}

function portalSortKey(row: Portal2bRow): string {
  return [
    row.supplierGstin ?? 'zzz',
    row.invoiceNumberNormalized,
    row.invoiceDate ?? '9999-99-99',
    totalTax(row.tax).toFixed(2).padStart(16, '0'),
    row.id,
  ].join('|');
}

export interface MatchPipelineInput {
  bookRows: readonly BookRow[];
  portalRows: readonly Portal2bRow[];
  /** How often each supplier files, keyed by GSTIN. Drives the QRMP on-time window. */
  filingFrequencyOf: (gstin: string | null, panKey: string | null) => FilingFrequency;
  /**
   * The newest period for which a GSTR-2B was loaded. A document whose on-time window
   * closes after this has not failed to arrive -- it is simply not due yet.
   */
  lastLoadedPeriod: PeriodKey | null;
}

/** The last period in which a document may still arrive without being late. */
export function onTimeWindowEnd(
  expectedPeriod: PeriodKey,
  frequency: FilingFrequency,
): PeriodKey {
  if (frequency === 'monthly') return expectedPeriod;
  return quarterOfPeriod(expectedPeriod)?.endPeriod ?? expectedPeriod;
}

/**
 * Whether a document's deadline to appear has not arrived yet.
 *
 * Without this, a quarterly filer's invoices from the current quarter are counted as
 * missing credit every single month until the quarter closes -- so every QRMP supplier
 * would carry a permanent red flag for doing nothing wrong. The same logic protects a
 * monthly supplier whose 2B for the latest period has not been downloaded yet.
 */
export function isNotYetDue(
  expectedPeriod: PeriodKey | null,
  frequency: FilingFrequency,
  lastLoadedPeriod: PeriodKey | null,
): boolean {
  if (expectedPeriod === null || lastLoadedPeriod === null) return false;
  return comparePeriods(onTimeWindowEnd(expectedPeriod, frequency), lastLoadedPeriod) > 0;
}

/**
 * Which 2B period a document should have appeared in.
 *
 * Taken from the invoice date: a monthly filer reports the month in their GSTR-1 by the
 * 11th of the following month, and the buyer's 2B for that month is generated on the
 * 14th. Quarterly filers get a wider on-time window, applied separately.
 */
export function expectedPeriodOf(book: BookRow): string | null {
  return book.invoiceDate ? periodFromDate(book.invoiceDate) : null;
}

export function runMatchPipeline(input: MatchPipelineInput): MatchResult[] {
  // Credit notes never enter invoice matching, and a superseded 2B row is a document
  // the supplier has already replaced -- matching against it would double-count.
  const books = input.bookRows
    .filter((row) => isMatchableDocument(row))
    .slice()
    .sort((a, b) => bookSortKey(a).localeCompare(bookSortKey(b)));

  const portals = input.portalRows
    .filter((row) => isMatchableDocument(row) && row.supersededById === null)
    .slice()
    .sort((a, b) => portalSortKey(a).localeCompare(portalSortKey(b)));

  const consumedBooks = new Set<string>();
  const consumedPortals = new Set<string>();
  const results: MatchResult[] = [];

  for (const { tier, predicate } of TIERS) {
    for (const book of books) {
      if (consumedBooks.has(book.id)) continue;

      const portal = portals.find(
        (candidate) => !consumedPortals.has(candidate.id) && predicate(book, candidate),
      );
      if (!portal) continue;

      consumedBooks.add(book.id);
      consumedPortals.add(portal.id);
      results.push(buildMatchedResult(book, portal, tier, input.filingFrequencyOf));
    }
  }

  for (const book of books) {
    if (consumedBooks.has(book.id)) continue;
    results.push(
      buildMissingInTwoBResult(book, input.filingFrequencyOf, input.lastLoadedPeriod),
    );
  }

  for (const portal of portals) {
    if (consumedPortals.has(portal.id)) continue;
    results.push(buildMissingInBooksResult(portal));
  }

  // One final deterministic ordering so the invoice detail export is stable.
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

function buildMatchedResult(
  book: BookRow,
  portal: Portal2bRow,
  tier: MatchTier,
  filingFrequencyOf: MatchPipelineInput['filingFrequencyOf'],
): MatchResult {
  const treatment = creditTreatmentForTier(tier);
  const expectedPeriod = expectedPeriodOf(book);
  const actualPeriod = portal.period;

  const frequency = filingFrequencyOf(book.supplierGstin, book.panKey);
  const onTime =
    expectedPeriod === null
      ? null
      : isWithinOnTimeWindow(expectedPeriod, actualPeriod, frequency);

  const delayMonths =
    expectedPeriod === null ? null : Math.max(0, monthsBetween(expectedPeriod, actualPeriod) ?? 0);

  // Delay beyond what this supplier is permitted. A quarterly filer inside their own
  // quarter has none, however many months after the invoice date the credit arrived.
  const excessDelayMonths =
    expectedPeriod === null
      ? null
      : Math.max(0, monthsBetween(onTimeWindowEnd(expectedPeriod, frequency), actualPeriod) ?? 0);

  const bookTax = totalTax(book.tax);
  const portalTax = totalTax(portal.tax);
  const inScope = book.scope.inScope;

  let taxReceived = 0;
  let taxAtRisk = 0;
  let taxNeedsCorrection = 0;

  if (treatment === 'received') {
    taxReceived = portalTax;
  } else if (treatment === 'partial') {
    // The 2B value is what actually reached the buyer; only the shortfall is exposed.
    taxReceived = portalTax;
    taxAtRisk = Math.max(0, roundRupees(bookTax - portalTax));
  } else {
    /*
     * 'needs_correction' (tiers 4 and 5) contributes to neither headline total, by
     * design -- but the document is real and belongs to a period, so its value is
     * carried separately rather than lost.
     */
    taxNeedsCorrection = portalTax;
  }

  if (!inScope) {
    taxAtRisk = 0;
    taxNeedsCorrection = 0;
  }

  const booksTaxHead = taxHeadOf(book.tax);
  const portalTaxHead = taxHeadOf(portal.tax);

  return {
    id: `m:${book.id}`,
    status: STATUS_BY_TIER[tier],
    tier,
    creditTreatment: inScope ? treatment : 'not_applicable',
    bookRowId: book.id,
    portalRowId: portal.id,
    supplierName: book.supplierName || portal.supplierName,
    supplierGstin: book.supplierGstin,
    panKey: book.panKey,
    invoiceNumber: book.invoiceNumber,
    invoiceNumberNormalized: book.invoiceNumberNormalized,
    invoiceDate: book.invoiceDate,
    docType: book.docType,
    expectedPeriod,
    actualPeriod,
    delayMonths,
    excessDelayMonths,
    notYetDue: false,
    onTime,
    taxHeadMismatch: isTaxHeadMismatch(booksTaxHead, portalTaxHead),
    booksTaxHead,
    portalTaxHead,
    taxAtRisk,
    taxReceived,
    taxNeedsCorrection,
    // Attribution is decided later, by analyse/attribution.ts.
    attribution: 'unattributed',
    inScope,
    scopeReason: book.scope.reason,
    invoiceNumberDistance: tier === 5 ? invoiceNumberDistance(book, portal) : null,
  };
}

function buildMissingInTwoBResult(
  book: BookRow,
  filingFrequencyOf: MatchPipelineInput['filingFrequencyOf'],
  lastLoadedPeriod: PeriodKey | null,
): MatchResult {
  const inScope = book.scope.inScope;
  const expectedPeriod = expectedPeriodOf(book);
  const frequency = filingFrequencyOf(book.supplierGstin, book.panKey);
  const notYetDue = isNotYetDue(expectedPeriod, frequency, lastLoadedPeriod);

  return {
    id: `m:${book.id}`,
    status: 'missing_in_2b',
    tier: null,
    creditTreatment: inScope && !notYetDue ? 'at_risk' : 'not_applicable',
    bookRowId: book.id,
    portalRowId: null,
    supplierName: book.supplierName,
    supplierGstin: book.supplierGstin,
    panKey: book.panKey,
    invoiceNumber: book.invoiceNumber,
    invoiceNumberNormalized: book.invoiceNumberNormalized,
    invoiceDate: book.invoiceDate,
    docType: book.docType,
    expectedPeriod,
    actualPeriod: null,
    delayMonths: null,
    excessDelayMonths: null,
    notYetDue,
    onTime: null,
    taxHeadMismatch: false,
    booksTaxHead: taxHeadOf(book.tax),
    portalTaxHead: 'none',
    taxAtRisk: inScope && !notYetDue ? totalTax(book.tax) : 0,
    taxReceived: 0,
    taxNeedsCorrection: 0,
    attribution: 'unattributed',
    inScope,
    scopeReason: book.scope.reason,
    invoiceNumberDistance: null,
  };
}

/**
 * A 2B row with no counterpart in the books.
 *
 * Never counted as at risk: the buyer cannot lose credit they never recorded buying.
 * It is still reported, because it usually means either an unrecorded purchase or an
 * invoice raised against the buyer's GSTIN that has nothing to do with them -- both
 * worth knowing about.
 */
function buildMissingInBooksResult(portal: Portal2bRow): MatchResult {
  return {
    id: `m:${portal.id}`,
    status: 'missing_in_books',
    tier: null,
    creditTreatment: 'not_applicable',
    bookRowId: null,
    portalRowId: portal.id,
    supplierName: portal.supplierName,
    supplierGstin: portal.supplierGstin,
    panKey: portal.panKey,
    invoiceNumber: portal.invoiceNumber,
    invoiceNumberNormalized: portal.invoiceNumberNormalized,
    invoiceDate: portal.invoiceDate,
    docType: portal.docType,
    expectedPeriod: portal.invoiceDate ? periodFromDate(portal.invoiceDate) : null,
    actualPeriod: portal.period,
    delayMonths: null,
    excessDelayMonths: null,
    notYetDue: false,
    onTime: null,
    taxHeadMismatch: false,
    booksTaxHead: 'none',
    portalTaxHead: taxHeadOf(portal.tax),
    taxAtRisk: 0,
    taxReceived: 0,
    taxNeedsCorrection: 0,
    attribution: 'unattributed',
    inScope: true,
    scopeReason: null,
    invoiceNumberDistance: null,
  };
}
