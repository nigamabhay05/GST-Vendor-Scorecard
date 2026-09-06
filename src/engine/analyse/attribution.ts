import { ATTRIBUTION } from '../config';
import { imsKey } from '../parse/imsLog';
import { roundRupees } from '../normalize/money';
import type {
  Attribution,
  AttributionSplitEntry,
  DeemedAcceptanceReport,
  ImsLogRow,
  MatchResult,
  PeriodKey,
} from '../types';

/**
 * Attribution: whose fault is each gap?
 *
 * This is the layer that separates this tool from a reconciliation report. A missing
 * invoice is not evidence against a supplier until you know the buyer's own staff did
 * not reject it. Two of the six buckets are the buyer's internal control findings and
 * must never touch a supplier's score.
 *
 * IMS is an enhancement, never a dependency. With no IMS log for a period, every gap in
 * it stays `unattributed` and the interface says so rather than guessing.
 */

/** The two buckets that count against a supplier. Everything else does not. */
export const SUPPLIER_FAULT_ATTRIBUTIONS: readonly Attribution[] = [
  'supplier_never_reported',
  'supplier_reported_late',
];

/** The two buckets that are the buyer's own control finding. */
export const RECIPIENT_CAUSE_ATTRIBUTIONS: readonly Attribution[] = [
  'recipient_rejected',
  'recipient_kept_pending',
];

export function isSupplierFault(attribution: Attribution): boolean {
  return SUPPLIER_FAULT_ATTRIBUTIONS.includes(attribution);
}

export function isRecipientCause(attribution: Attribution): boolean {
  return RECIPIENT_CAUSE_ATTRIBUTIONS.includes(attribution);
}

export interface AttributionContext {
  imsIndex: Map<string, ImsLogRow>;
  /** Periods for which the user actually supplied an IMS log. */
  periodsWithImsLog: Set<PeriodKey>;
}

/**
 * Whether an IMS log covering this document exists at all.
 *
 * Checked against the period the document was *expected* in and the period it actually
 * arrived in, because a buyer often acts on a record in a later period than the one it
 * belongs to.
 */
function hasImsCoverage(result: MatchResult, context: AttributionContext): boolean {
  if (context.periodsWithImsLog.size === 0) return false;
  const candidates = [result.expectedPeriod, result.actualPeriod].filter(
    (period): period is PeriodKey => period !== null,
  );
  if (candidates.length === 0) return context.periodsWithImsLog.size > 0;
  return candidates.some((period) => context.periodsWithImsLog.has(period));
}

/**
 * Classifies one match result into exactly one attribution bucket.
 *
 * The order of the rules is the substance:
 *
 *   1. Out of scope explains nothing -- there was no credit to lose.
 *   2. A gap the buyer rejected or held is the buyer's, whatever the supplier did.
 *      Getting this precedence wrong is precisely the error that makes a tool like this
 *      blame the wrong party, and it is the reason the IMS log is worth uploading.
 *   3. A gap with an IMS log covering it, and no buyer action against it, means the
 *      record never reached IMS -- so the supplier never reported it.
 *   4. Arrived, but late: the supplier's, and the only other bucket that scores.
 *   5. Arrived on time with nobody acting on it: deemed accepted. Not a supplier
 *      failure at all, but a control weakness worth naming.
 */
export function attributeResult(
  result: MatchResult,
  context: AttributionContext,
): Attribution {
  if (!result.inScope) return 'unattributed';

  // A 2B row with no book counterpart is not a gap in the buyer's credit.
  if (result.status === 'missing_in_books') return 'unattributed';

  const ims = context.imsIndex.get(
    imsKey(result.supplierGstin, result.invoiceNumberNormalized),
  );
  const covered = hasImsCoverage(result, context);

  if (result.status === 'missing_in_2b') {
    if (ims?.action === 'Reject') return 'recipient_rejected';
    if (ims?.action === 'Pending') return 'recipient_kept_pending';
    if (!covered) return 'unattributed';
    return 'supplier_never_reported';
  }

  if (result.onTime === false) return 'supplier_reported_late';

  if (result.onTime === true) {
    if (!covered) return 'unattributed';
    if (!ims || ims.action === 'NoAction') return 'deemed_accepted';
    return 'unattributed';
  }

  return 'unattributed';
}

/** Applies attribution to every result, in place, and returns the same array. */
export function attributeAll(
  results: MatchResult[],
  context: AttributionContext,
): MatchResult[] {
  for (const result of results) {
    result.attribution = attributeResult(result, context);
  }
  return results;
}

/**
 * True when a result is something the user needs explained.
 *
 * An invoice that arrived on time and was actively accepted needs no explanation, and
 * including those in the attribution split would bury the real findings under a
 * mountain of healthy rows.
 */
export function needsExplanation(result: MatchResult): boolean {
  if (!result.inScope) return false;
  if (result.status === 'missing_in_books') return false;
  return !(result.status === 'matched' && result.onTime === true && result.attribution === 'unattributed');
}

/**
 * Whether a supplier's gaps are better explained by a wrong recipient GSTIN than by
 * non-filing.
 *
 * The reasoning, which is the whole of the rule:
 *
 *   - Some documents are missing from every GSTR-2B period loaded.
 *   - The same supplier has *other* invoices that arrived on time in those same
 *     periods, which is direct evidence they filed their GSTR-1 for them.
 *   - The missing ones have no IMS entry either, so the user did not reject or hold
 *     them -- they never reached the buyer's IMS at all.
 *
 * A supplier who filed on time cannot simultaneously have not filed. What remains is
 * that those particular invoices were reported against somebody else's GSTIN, and the
 * credit is sitting in a stranger's 2B.
 *
 * This is a hypothesis and is worded as one wherever it surfaces. The other party's 2B
 * is not visible from here and never will be, so the tool proposes the check rather than
 * announcing the finding. It changes the suggested action and the follow-up email; it
 * does not change the score, because the evidence does not rise to that.
 */
export function suspectsWrongRecipientGstin(input: {
  results: readonly MatchResult[];
  /** True when the IMS log has an entry for this document. */
  hasImsEntry: (result: MatchResult) => boolean;
}): { suspected: boolean; documents: MatchResult[]; confirmedPeriods: PeriodKey[] } {
  const none = { suspected: false, documents: [] as MatchResult[], confirmedPeriods: [] as PeriodKey[] };

  // Periods this supplier demonstrably filed for: an invoice of theirs arrived on time.
  const confirmed = new Set<PeriodKey>();
  let onTimeCount = 0;

  for (const result of input.results) {
    if (result.onTime !== true || result.taxReceived + result.taxNeedsCorrection <= 0) continue;
    onTimeCount += 1;
    const period = result.expectedPeriod ?? result.actualPeriod;
    if (period !== null) confirmed.add(period);
  }

  if (onTimeCount < ATTRIBUTION.minOnTimeSiblingsForWrongGstin) return none;

  /*
   * Only worth raising about a supplier who is otherwise reliable. A poor filer's
   * missing invoices are explained perfectly well by poor filing, and pointing the user
   * at recipient GSTINs would send them down the wrong road entirely.
   */
  const considered = input.results.filter(
    (result) => result.inScope && !result.notYetDue && result.status !== 'missing_in_books',
  );
  if (considered.length === 0) return none;
  if (onTimeCount / considered.length < ATTRIBUTION.minCleanShareForWrongGstin) return none;

  const documents = input.results.filter(
    (result) =>
      result.status === 'missing_in_2b' &&
      result.inScope &&
      !result.notYetDue &&
      // Never reached IMS, so the user neither rejected nor held it.
      !input.hasImsEntry(result) &&
      result.expectedPeriod !== null &&
      confirmed.has(result.expectedPeriod),
  );

  if (documents.length === 0) return none;

  /*
   * One stray invoice in one month is an ordinary slip. The pattern that points at a
   * wrong GSTIN is the same thing recurring while everything else arrives on time.
   */
  const affectedPeriods = new Set(documents.map((result) => result.expectedPeriod));
  if (affectedPeriods.size < ATTRIBUTION.minAffectedPeriodsForWrongGstin) return none;

  return {
    suspected: true,
    documents,
    confirmedPeriods: [...confirmed].sort(),
  };
}

export function buildAttributionSplit(results: readonly MatchResult[]): AttributionSplitEntry[] {
  const order: Attribution[] = [
    'supplier_never_reported',
    'supplier_reported_late',
    'recipient_rejected',
    'recipient_kept_pending',
    'deemed_accepted',
    'unattributed',
  ];

  const counts = new Map<Attribution, { count: number; taxValue: number }>();
  for (const attribution of order) counts.set(attribution, { count: 0, taxValue: 0 });

  for (const result of results) {
    if (!needsExplanation(result)) continue;
    const bucket = counts.get(result.attribution);
    if (!bucket) continue;
    bucket.count += 1;
    // At-risk where there is exposure, received value otherwise, so a late-but-arrived
    // invoice still shows the value it held up.
    bucket.taxValue = roundRupees(
      bucket.taxValue + (result.taxAtRisk > 0 ? result.taxAtRisk : result.taxReceived),
    );
  }

  return order.map((attribution) => {
    const bucket = counts.get(attribution) ?? { count: 0, taxValue: 0 };
    return {
      attribution,
      count: bucket.count,
      taxValue: bucket.taxValue,
      isRecipientCause: isRecipientCause(attribution),
    };
  });
}

/**
 * Deemed acceptance.
 *
 * Under IMS, a record nobody acts on is deemed accepted when GSTR-3B is filed. A high
 * figure here is not a supplier problem at all -- it says the buyer's team is not
 * reviewing what arrives, and is accepting whatever suppliers report by default.
 *
 * A record counts as deemed accepted when the IMS log marks it `NoAction`, or when a log
 * exists for the period and the record has no entry in it at all. Silence is the
 * commonest form of no action, and counting only explicit `NoAction` rows would
 * understate the finding to the point of hiding it.
 */
export function buildDeemedAcceptanceReport(
  results: readonly MatchResult[],
  context: AttributionContext,
): DeemedAcceptanceReport {
  const imsLogSupplied = context.periodsWithImsLog.size > 0;

  let count = 0;
  let taxValue = 0;
  let receivedRecords = 0;

  for (const result of results) {
    if (!result.inScope) continue;
    // Anything with a 2B counterpart arrived, including tier 4 and 5 results. The
    // denominator has to match the attribution split above or the headline percentage
    // and the Findings screen would disagree with each other.
    if (result.portalRowId === null) continue;

    receivedRecords += 1;
    if (result.attribution === 'deemed_accepted') {
      count += 1;
      taxValue = roundRupees(taxValue + result.taxReceived);
    }
  }

  return {
    count,
    taxValue,
    share: receivedRecords === 0 ? 0 : count / receivedRecords,
    imsLogSupplied,
    periodsWithImsLog: [...context.periodsWithImsLog].sort(),
  };
}
