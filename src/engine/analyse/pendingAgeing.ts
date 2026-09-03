import { AGEING } from '../config';
import { roundRupees } from '../normalize/money';
import { daysBetween, section16_4Deadline } from '../normalize/period';
import type {
  AgeingBucket,
  DateOnly,
  DeadlineFlag,
  ImsLogRow,
  MatchResult,
  PendingAgeingReport,
  PendingAgeingRow,
} from '../types';

/**
 * Pending IMS records, and how long they have left.
 *
 * The ageing buckets are the familiar part. The part that earns this screen its place is
 * the countdown to 30 November: input tax credit for a financial year cannot be claimed
 * after 30 November of the following year, so a record left pending past that date is
 * not late, it is gone. Nothing else in the tool surfaces credit that is about to expire
 * quietly while everyone is looking at this month's reconciliation.
 */

export function bucketForAge(ageDays: number): AgeingBucket {
  const [first, second, third] = AGEING.bucketBoundsDays;
  if (ageDays <= first) return '0-30';
  if (ageDays <= second) return '31-60';
  if (ageDays <= third) return '61-90';
  return '90+';
}

/**
 * How urgent a pending record is, measured against its own section 16(4) deadline.
 *
 * Red is not a warning that the deadline is near in the abstract -- it is the point at
 * which there is barely time left to chase the supplier, have them correct their
 * filing, and still claim the credit.
 */
export function deadlineFlagFor(daysToDeadline: number): DeadlineFlag {
  if (daysToDeadline < 0) return 'expired';
  if (daysToDeadline <= AGEING.deadlineRedWindowDays) return 'red';
  if (daysToDeadline <= AGEING.deadlineAmberWindowDays) return 'amber';
  return 'ok';
}

export interface PendingAgeingInput {
  imsRows: readonly ImsLogRow[];
  results: readonly MatchResult[];
  /** Reference date. Explicit rather than `new Date()` so a run is reproducible. */
  asOf: DateOnly;
}

const EMPTY_BUCKETS = (): Record<AgeingBucket, { rows: number; taxValue: number }> => ({
  '0-30': { rows: 0, taxValue: 0 },
  '31-60': { rows: 0, taxValue: 0 },
  '61-90': { rows: 0, taxValue: 0 },
  '90+': { rows: 0, taxValue: 0 },
});

export function buildPendingAgeing(input: PendingAgeingInput): PendingAgeingReport {
  // Tax value comes from the matched document where one exists: the IMS log carries the
  // document total, not the tax, and it is the tax that is actually at stake.
  const taxByKey = new Map<string, number>();
  const nameByKey = new Map<string, string>();
  for (const result of input.results) {
    const key = `${result.supplierGstin ?? ''}|${result.invoiceNumberNormalized}`;
    taxByKey.set(key, result.taxAtRisk + result.taxReceived);
    if (result.supplierName) nameByKey.set(key, result.supplierName);
  }

  const rows: PendingAgeingRow[] = [];
  const byBucket = EMPTY_BUCKETS();

  for (const ims of input.imsRows) {
    if (ims.action !== 'Pending') continue;

    // Ageing runs from the action date where there is one, and from the document date
    // otherwise -- a record nobody ever touched has been pending since it arrived.
    const start = ims.actionDate ?? ims.invoiceDate;
    if (!start) continue;

    const ageDays = daysBetween(start, input.asOf);
    if (ageDays === null) continue;

    const deadlineSource = ims.invoiceDate ?? start;
    const deadline = section16_4Deadline(deadlineSource);
    if (!deadline) continue;

    const daysToDeadline = daysBetween(input.asOf, deadline) ?? 0;
    const key = `${ims.gstin ?? ''}|${ims.invoiceNumberNormalized}`;
    const taxValue = roundRupees(taxByKey.get(key) ?? 0);
    const bucket = bucketForAge(Math.max(0, ageDays));

    rows.push({
      imsRowId: ims.id,
      supplierName: nameByKey.get(key) ?? '',
      supplierGstin: ims.gstin,
      invoiceNumber: ims.invoiceNumber,
      invoiceDate: ims.invoiceDate,
      value: ims.value,
      taxValue,
      ageDays: Math.max(0, ageDays),
      bucket,
      section16_4Deadline: deadline,
      daysToDeadline,
      deadlineFlag: deadlineFlagFor(daysToDeadline),
    });

    byBucket[bucket].rows += 1;
    byBucket[bucket].taxValue = roundRupees(byBucket[bucket].taxValue + taxValue);
  }

  // Most urgent first: the whole point of the screen is what to do this week.
  rows.sort(
    (a, b) => a.daysToDeadline - b.daysToDeadline || b.taxValue - a.taxValue || a.imsRowId.localeCompare(b.imsRowId),
  );

  const totalTaxValue = roundRupees(rows.reduce((sum, row) => sum + row.taxValue, 0));
  const atRiskOfExpiryTaxValue = roundRupees(
    rows
      .filter((row) => row.deadlineFlag === 'red' || row.deadlineFlag === 'expired')
      .reduce((sum, row) => sum + row.taxValue, 0),
  );

  return {
    rows,
    byBucket,
    asOf: input.asOf,
    totalTaxValue,
    atRiskOfExpiryTaxValue,
  };
}
