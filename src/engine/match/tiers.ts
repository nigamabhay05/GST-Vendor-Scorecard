import { DATES, MATCHING } from '../config';
import { levenshtein } from '../normalize/invoiceNumber';
import { amountsEqual, totalTax } from '../normalize/money';
import { daysBetween } from '../normalize/period';
import type { BookRow, MatchTier, Portal2bRow } from '../types';

/**
 * The five match tiers, one exported predicate each.
 *
 * Each tier answers one question: "under this rule, are these the same document?" They
 * are pure and independent, so each can be tested in isolation, and the pipeline is
 * free to apply them in strict order without any tier knowing about the others.
 *
 * A note on "exact" values. The brief describes tier 3 as matching on an exact taxable
 * value, but exact equality between two floating-point rupee figures -- one rounded per
 * line by Tally, one rounded per document by the portal -- is not a meaningful test.
 * Every value comparison here therefore uses the configured one-rupee tolerance.
 * Recorded in ASSUMPTIONS.md.
 */

/** Documents this pipeline matches. Credit notes are tracked separately, never matched. */
export function isMatchableDocument(row: { docType: string }): boolean {
  return row.docType === 'invoice' || row.docType === 'debit_note';
}

/** Both sides must agree on what kind of document this is. */
function sameDocumentType(book: BookRow, portal: Portal2bRow): boolean {
  return book.docType === portal.docType;
}

function sameGstin(book: BookRow, portal: Portal2bRow): boolean {
  return book.supplierGstin !== null && book.supplierGstin === portal.supplierGstin;
}

function samePan(book: BookRow, portal: Portal2bRow): boolean {
  return book.panKey !== null && book.panKey === portal.panKey;
}

function sameInvoiceNumber(book: BookRow, portal: Portal2bRow): boolean {
  return (
    book.invoiceNumberNormalized !== '' &&
    book.invoiceNumberNormalized === portal.invoiceNumberNormalized
  );
}

function taxEqual(book: BookRow, portal: Portal2bRow): boolean {
  return amountsEqual(totalTax(book.tax), totalTax(portal.tax));
}

/** Tier 1 -- GSTIN, normalised invoice number, and total tax within the tolerance. */
export function matchesTier1(book: BookRow, portal: Portal2bRow): boolean {
  return (
    sameGstin(book, portal) &&
    sameDocumentType(book, portal) &&
    sameInvoiceNumber(book, portal) &&
    taxEqual(book, portal)
  );
}

/**
 * Tier 2 -- the same document by GSTIN and number, but the values disagree.
 *
 * The credit did arrive, just not all of it, so this is a value mismatch rather than a
 * gap: the 2B value is received and only the shortfall is at risk.
 */
export function matchesTier2(book: BookRow, portal: Portal2bRow): boolean {
  return (
    sameGstin(book, portal) &&
    sameDocumentType(book, portal) &&
    sameInvoiceNumber(book, portal) &&
    !taxEqual(book, portal)
  );
}

/**
 * Tier 3 -- GSTIN and taxable value agree, and the dates are within a few days.
 *
 * This catches the supplier whose invoice number format differs entirely from the one
 * the buyer recorded. The credit is genuinely there, so tier 3 counts as received.
 */
export function matchesTier3(book: BookRow, portal: Portal2bRow): boolean {
  if (!sameGstin(book, portal) || !sameDocumentType(book, portal)) return false;
  if (!amountsEqual(book.tax.taxable, portal.tax.taxable)) return false;
  if (book.invoiceDate === null || portal.invoiceDate === null) return false;

  const gap = daysBetween(book.invoiceDate, portal.invoiceDate);
  return gap !== null && Math.abs(gap) <= DATES.tier3DateToleranceDays;
}

/**
 * Tier 4 -- same PAN and invoice number and value, but a different GSTIN.
 *
 * One business, two state registrations: the supplier reported the document under a
 * GSTIN the buyer did not expect. The credit exists but is not usable by this
 * registration as it stands, so tier 4 is reported as needing correction rather than
 * being counted as received or as at risk.
 */
export function matchesTier4(book: BookRow, portal: Portal2bRow): boolean {
  return (
    !sameGstin(book, portal) &&
    samePan(book, portal) &&
    sameDocumentType(book, portal) &&
    sameInvoiceNumber(book, portal) &&
    taxEqual(book, portal)
  );
}

/**
 * Tier 5 -- GSTIN and value agree and the invoice number is within a couple of edits.
 *
 * A transposed or dropped character. Deliberately the last tier and always labelled for
 * review: this is the only tier that can be wrong about identity, so it never counts as
 * credit received.
 */
export function matchesTier5(book: BookRow, portal: Portal2bRow): boolean {
  if (!sameGstin(book, portal) || !sameDocumentType(book, portal)) return false;
  if (!taxEqual(book, portal)) return false;
  if (book.invoiceNumberNormalized === '' || portal.invoiceNumberNormalized === '') return false;
  if (sameInvoiceNumber(book, portal)) return false;

  return (
    levenshtein(
      book.invoiceNumberNormalized,
      portal.invoiceNumberNormalized,
      MATCHING.tier5MaxLevenshtein,
    ) <= MATCHING.tier5MaxLevenshtein
  );
}

export interface TierDefinition {
  tier: MatchTier;
  label: string;
  predicate: (book: BookRow, portal: Portal2bRow) => boolean;
}

/** The tiers in the order the pipeline applies them. Order is the whole design. */
export const TIERS: readonly TierDefinition[] = [
  { tier: 1, label: 'Matched', predicate: matchesTier1 },
  { tier: 2, label: 'Value mismatch', predicate: matchesTier2 },
  { tier: 3, label: 'Invoice number mismatch', predicate: matchesTier3 },
  { tier: 4, label: 'GSTIN / state mismatch', predicate: matchesTier4 },
  { tier: 5, label: 'Probable match, review', predicate: matchesTier5 },
];

/** The invoice-number edit distance, for display on a tier 5 review row. */
export function invoiceNumberDistance(book: BookRow, portal: Portal2bRow): number {
  return levenshtein(book.invoiceNumberNormalized, portal.invoiceNumberNormalized);
}
