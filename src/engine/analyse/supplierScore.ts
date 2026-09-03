import { ACTION_THRESHOLDS, FILING, RECOVERY, SCORING } from '../config';
import { roundRupees } from '../normalize/money';
import { comparePeriods, quarterOfPeriod } from '../normalize/period';
import type {
  Attribution,
  FilingFrequency,
  FilingFrequencySource,
  MatchResult,
  MonthlyMatchRate,
  PeriodKey,
  Portal2bRow,
  RecoveryRateBasis,
  ScoreComponentPoints,
  ScoreComponents,
  SupplierContact,
  SupplierFlag,
  SupplierMasterRow,
  SupplierScorecardEntry,
} from '../types';
import { isRecipientCause, isSupplierFault } from './attribution';

/**
 * Supplier scoring.
 *
 * Every weight, threshold and window comes from config.ts, so a firm that disagrees
 * about where amber starts changes one line rather than hunting through arithmetic.
 *
 * The single most important rule in this file is the one that refuses to score at all.
 * A supplier with fewer than three periods of history gets `Insufficient history` and no
 * number, because a confident red flag drawn from one bad month would send someone to
 * make a phone call they should not make -- and the tool would deserve to lose their
 * trust for it.
 */

/** Suppliers are keyed by GSTIN where there is one, and by normalised name otherwise. */
export function supplierKey(gstin: string | null, name: string): string {
  if (gstin) return gstin;
  const nameKey = name.trim().toLowerCase();
  return nameKey === '' ? 'unknown-supplier' : `name:${nameKey}`;
}

// ------------------------------------------------------------ filing frequency

/**
 * Infers how often a supplier files from the filing dates observed in GSTR-2B.
 *
 * Only used when the supplier master is absent or silent. A supplier whose filings land
 * in at most one month per quarter, across at least two quarters, is treated as
 * quarterly -- and flagged low confidence, because getting this wrong either excuses
 * three months of real lateness or penalises a supplier for a scheme they are entitled
 * to use.
 */
export function inferFilingFrequency(filingDates: readonly string[]): {
  frequency: FilingFrequency;
  source: FilingFrequencySource;
  confidence: 'high' | 'low';
} {
  const months = new Set(filingDates.filter(Boolean).map((date) => date.slice(0, 7)));
  if (months.size === 0) {
    return { frequency: FILING.defaultFrequency, source: 'default', confidence: 'low' };
  }

  const byQuarter = new Map<string, Set<string>>();
  for (const month of months) {
    const quarter = quarterOfPeriod(month);
    if (!quarter) continue;
    const key = quarter.startPeriod;
    const bucket = byQuarter.get(key) ?? new Set<string>();
    bucket.add(month);
    byQuarter.set(key, bucket);
  }

  if (byQuarter.size < FILING.inferenceMinQuarters) {
    return { frequency: FILING.defaultFrequency, source: 'default', confidence: 'low' };
  }

  const everyQuarterSparse = [...byQuarter.values()].every(
    (set) => set.size <= FILING.inferenceMaxFilingMonthsPerQuarter,
  );

  return everyQuarterSparse
    ? { frequency: 'quarterly', source: 'inferred', confidence: 'low' }
    : { frequency: 'monthly', source: 'inferred', confidence: 'low' };
}

export interface FilingFrequencyResolution {
  frequency: FilingFrequency;
  source: FilingFrequencySource;
  confidence: 'high' | 'low';
}

/** The supplier master is believed when it speaks; otherwise the pattern is inferred. */
export function resolveFilingFrequency(
  master: SupplierMasterRow | undefined,
  filingDates: readonly string[],
): FilingFrequencyResolution {
  if (master?.filingFrequency) {
    return { frequency: master.filingFrequency, source: 'master', confidence: 'high' };
  }
  return inferFilingFrequency(filingDates);
}

// -------------------------------------------------------------- components

/** Scales a raw measure onto 0-100 points, clamped. */
function pointsFromRatio(value: number, zeroAt: number, higherIsBetter: boolean): number {
  if (zeroAt <= 0) return higherIsBetter ? value * 100 : 100;
  const ratio = Math.min(1, Math.max(0, value / zeroAt));
  return higherIsBetter ? ratio * 100 : (1 - ratio) * 100;
}

export function componentPointsOf(components: ScoreComponents): ScoreComponentPoints {
  return {
    matchRate: Math.min(100, Math.max(0, components.matchRate * 100)),
    avgDelayMonths: pointsFromRatio(
      components.avgDelayMonths,
      SCORING.delayMonthsForZeroPoints,
      false,
    ),
    volatility: pointsFromRatio(components.volatility, SCORING.volatilityForZeroPoints, false),
    disputeRate: pointsFromRatio(components.disputeRate, SCORING.disputeRateForZeroPoints, false),
  };
}

export function weightedScore(points: ScoreComponentPoints): number {
  const { weights } = SCORING;
  const total = weights.matchRate + weights.avgDelayMonths + weights.volatility + weights.disputeRate;

  const sum =
    points.matchRate * weights.matchRate +
    points.avgDelayMonths * weights.avgDelayMonths +
    points.volatility * weights.volatility +
    points.disputeRate * weights.disputeRate;

  return Math.round(sum / total);
}

export function flagForScore(score: number | null, periodsWithData: number): SupplierFlag {
  if (score === null || periodsWithData < SCORING.minPeriodsForScore) return 'insufficient_history';
  if (score >= SCORING.flagThresholds.green) return 'green';
  if (score >= SCORING.flagThresholds.amber) return 'amber';
  return 'red';
}

/** Population standard deviation. Zero for a single observation, by definition. */
export function populationStdDev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------- recovery

export interface RecoveryInput {
  /** Gaps whose fate is known: did the invoice turn up in a later loaded period? */
  resolved: number;
  recovered: number;
}

/**
 * The share of gaps that eventually resolve.
 *
 * A gap counts as recovered if the invoice appears in any later loaded period. That
 * carries a known bias -- an old gap had more periods in which to resolve than a recent
 * one, so the rate reads slightly pessimistic on the newest month. The bias is stated in
 * the interface and in ASSUMPTIONS.md rather than hidden, because a user has to be able
 * to defend expected cash loss to a client.
 */
export function recoveryRateFor(
  supplier: RecoveryInput,
  global: RecoveryInput,
): RecoveryRateBasis {
  if (supplier.resolved >= RECOVERY.minGapsForSupplierRate) {
    return {
      rate: supplier.recovered / supplier.resolved,
      source: 'supplier',
      sampleSize: supplier.resolved,
    };
  }

  if (global.resolved > 0) {
    return {
      rate: global.recovered / global.resolved,
      source: 'global',
      sampleSize: global.resolved,
    };
  }

  return {
    rate: RECOVERY.defaultGlobalRecoveryRate,
    source: 'global',
    sampleSize: 0,
  };
}

// ------------------------------------------------------------ suggested action

export function suggestedActionFor(entry: {
  flag: SupplierFlag;
  components: ScoreComponents;
  expectedCashLoss: number;
  concentration: number;
  itcAtRisk: number;
  needsCorrectionValue: number;
  attributionValue: Record<Attribution, number>;
  filingFrequency: FilingFrequency;
}): string {
  const recipientValue =
    entry.attributionValue.recipient_rejected + entry.attributionValue.recipient_kept_pending;

  // The buyer's own doing outweighs anything to say to the supplier.
  if (recipientValue > entry.itcAtRisk * 0.5 && recipientValue > 0) {
    return 'Review your own IMS decisions first: most of this gap is credit your team rejected or is still holding.';
  }

  // A supplier whose whole volume needs correction has no measurable match rate, so
  // the score says nothing. The correction is the action, not the score.
  if (entry.needsCorrectionValue > 0 && entry.itcAtRisk === 0) {
    return 'Reported under a different GSTIN or invoice number. Ask the supplier to amend, then re-run.';
  }

  if (entry.flag === 'insufficient_history') {
    return 'Not enough history to score. Re-check once three periods of data are loaded.';
  }

  if (entry.flag === 'red' && entry.expectedCashLoss >= ACTION_THRESHOLDS.materialCashLossRupees) {
    return 'Escalate now: hold payment against unreported invoices and get a written filing commitment before the next cycle.';
  }

  if (entry.flag === 'red') {
    return 'Call the supplier and ask for their GSTR-1 filing date for the current period.';
  }

  if (entry.flag === 'amber' && entry.components.avgDelayMonths >= 1) {
    return 'Chase early: send the follow-up before the 11th so the invoice makes this period.';
  }

  if (entry.flag === 'amber') {
    return 'Watch. Confirm the missing invoices are reported in the next GSTR-1.';
  }

  if (entry.concentration >= ACTION_THRESHOLDS.highConcentration) {
    return 'No action needed, but this supplier carries a large share of your credit. Keep the monthly check in place.';
  }

  return 'No action needed.';
}

// ------------------------------------------------------------------ scoring

export interface SupplierScoringInput {
  key: string;
  gstin: string | null;
  panKey: string | null;
  name: string;
  results: readonly MatchResult[];
  /** Periods in the scoring window that this supplier had any in-scope book value in. */
  scoringPeriods: readonly PeriodKey[];
  master: SupplierMasterRow | undefined;
  portalRows: readonly Portal2bRow[];
  totalInScopeItc: number;
  globalRecovery: RecoveryInput;
  supplierRecovery: RecoveryInput;
  creditNoteIssueValue: number;
}

const EMPTY_ATTRIBUTION_TOTALS = (): Record<Attribution, number> => ({
  supplier_never_reported: 0,
  supplier_reported_late: 0,
  recipient_rejected: 0,
  recipient_kept_pending: 0,
  deemed_accepted: 0,
  unattributed: 0,
});

export function scoreSupplier(input: SupplierScoringInput): SupplierScorecardEntry {
  const inWindow = input.results.filter(
    (result) =>
      result.inScope &&
      result.status !== 'missing_in_books' &&
      isInWindow(result, input.scoringPeriods),
  );

  const attributionCounts = EMPTY_ATTRIBUTION_TOTALS();
  const attributionValue = EMPTY_ATTRIBUTION_TOTALS();

  let inScopeValue = 0;
  /*
   * Every in-scope rupee for this supplier, including credit the buyer rejected.
   * Concentration answers "how much of my credit rides on this supplier", which is a
   * question about volume, not about whose fault anything is -- so it uses this rather
   * than the narrower scoring base below.
   */
  let totalValue = 0;
  let onTimeReceivedValue = 0;
  let atRiskValue = 0;
  let needsCorrectionValue = 0;
  let supplierFaultValue = 0;
  let delayWeightedSum = 0;
  let delayWeight = 0;

  for (const result of inWindow) {
    const documentValue = result.taxReceived + result.taxAtRisk;

    attributionCounts[result.attribution] += 1;
    attributionValue[result.attribution] = roundRupees(
      attributionValue[result.attribution] + documentValue,
    );

    totalValue += documentValue;
    atRiskValue += result.taxAtRisk;
    if (result.creditTreatment === 'needs_correction') {
      needsCorrectionValue += result.taxReceived > 0 ? result.taxReceived : 0;
    }

    /*
     * Two kinds of value are kept out of the match-rate denominator entirely.
     *
     * Credit the buyer rejected or is still holding: the brief is explicit that only
     * supplier-caused gaps affect a supplier's score, and leaving these in would give a
     * supplier who filed everything correctly a match rate of zero -- which is exactly
     * the wrong answer, and the reason the IMS log is worth uploading at all.
     *
     * Documents not yet due: a quarterly filer's current-quarter invoices have not
     * failed to arrive, so counting them as unmatched would flag every QRMP supplier
     * every month.
     */
    if (isRecipientCause(result.attribution) || result.notYetDue) continue;

    inScopeValue += documentValue;

    if (isSupplierFault(result.attribution)) supplierFaultValue += documentValue;

    if (result.onTime === true) onTimeReceivedValue += result.taxReceived;

    if (result.excessDelayMonths !== null && result.taxReceived > 0) {
      // Value-weighted, and measured beyond the permitted window: a large invoice two
      // months later than allowed matters more than a small one.
      delayWeightedSum += result.excessDelayMonths * result.taxReceived;
      delayWeight += result.taxReceived;
    }
  }

  const monthlyMatchRate = buildMonthlyMatchRate(inWindow, input.scoringPeriods);
  const observedPeriods = monthlyMatchRate.filter((m) => m.matchRate !== null);

  const components: ScoreComponents = {
    matchRate: inScopeValue === 0 ? 1 : onTimeReceivedValue / inScopeValue,
    avgDelayMonths: delayWeight === 0 ? 0 : delayWeightedSum / delayWeight,
    volatility: populationStdDev(
      observedPeriods.map((m) => m.matchRate).filter((rate): rate is number => rate !== null),
    ),
    disputeRate:
      inScopeValue === 0
        ? 0
        : (supplierFaultValue + input.creditNoteIssueValue) / inScopeValue,
  };

  const componentPoints = componentPointsOf(components);
  const periodsWithData = observedPeriods.length;

  const hasEnoughHistory = periodsWithData >= SCORING.minPeriodsForScore;
  const score = hasEnoughHistory ? weightedScore(componentPoints) : null;
  const flag = flagForScore(score, periodsWithData);

  const recoveryBasis = recoveryRateFor(input.supplierRecovery, input.globalRecovery);
  const itcAtRisk = roundRupees(atRiskValue);
  const expectedCashLoss = roundRupees(itcAtRisk * (1 - recoveryBasis.rate));

  const filing = resolveFilingFrequency(
    input.master,
    input.portalRows.map((row) => row.gstr1FilingDate ?? '').filter(Boolean),
  );

  const concentration =
    input.totalInScopeItc === 0 ? 0 : totalValue / input.totalInScopeItc;

  return {
    key: input.key,
    gstin: input.gstin,
    panKey: input.panKey,
    name: input.name,
    periodsWithData,
    score,
    flag,
    components,
    componentPoints,
    itcAtRisk,
    needsCorrectionValue: roundRupees(needsCorrectionValue),
    expectedCashLoss,
    recoveryBasis,
    concentration,
    filingFrequency: filing.frequency,
    filingFrequencySource: filing.source,
    filingFrequencyConfidence: filing.confidence,
    monthlyMatchRate,
    attributionCounts,
    attributionValue,
    suggestedAction: suggestedActionFor({
      flag,
      components,
      expectedCashLoss,
      concentration,
      itcAtRisk,
      needsCorrectionValue: roundRupees(needsCorrectionValue),
      attributionValue,
      filingFrequency: filing.frequency,
    }),
    contact: contactOf(input.master),
    matchResultIds: input.results.map((result) => result.id),
  };
}

function isInWindow(result: MatchResult, scoringPeriods: readonly PeriodKey[]): boolean {
  if (scoringPeriods.length === 0) return true;
  const period = result.expectedPeriod ?? result.actualPeriod;
  if (period === null) return false;

  const first = scoringPeriods[0];
  const last = scoringPeriods[scoringPeriods.length - 1];
  if (!first || !last) return true;

  return comparePeriods(period, first) >= 0 && comparePeriods(period, last) <= 0;
}

function buildMonthlyMatchRate(
  results: readonly MatchResult[],
  scoringPeriods: readonly PeriodKey[],
): MonthlyMatchRate[] {
  return scoringPeriods.map((period) => {
    // Same exclusions as the overall match rate, so the chart and the score agree.
    const forPeriod = results.filter(
      (r) =>
        (r.expectedPeriod ?? r.actualPeriod) === period &&
        !isRecipientCause(r.attribution) &&
        !r.notYetDue,
    );

    const inScopeValue = forPeriod.reduce((sum, r) => sum + r.taxReceived + r.taxAtRisk, 0);
    const onTimeValue = forPeriod.reduce(
      (sum, r) => sum + (r.onTime === true ? r.taxReceived : 0),
      0,
    );

    return {
      period,
      // Null, not zero: a period the supplier simply had no business in says nothing
      // about them, and averaging a zero into it would.
      matchRate: inScopeValue === 0 ? null : onTimeValue / inScopeValue,
      inScopeValue: roundRupees(inScopeValue),
    };
  });
}

function contactOf(master: SupplierMasterRow | undefined): SupplierContact | null {
  if (!master) return null;
  return {
    contactPerson: master.contactPerson,
    email: master.email,
    phone: master.phone,
    paymentTermsDays: master.paymentTermsDays,
  };
}
