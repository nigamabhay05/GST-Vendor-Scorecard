import { AGEING, MATCHING, RECOVERY, SCORING } from '../engine/config';

/**
 * One plain sentence for every derived number on screen.
 *
 * These are generated from the engine's configuration rather than typed out, so a
 * threshold changed in config.ts changes the sentence the user reads at the same moment
 * it changes the arithmetic. A tooltip that quietly goes out of date is worse than no
 * tooltip: it teaches the reader to defend a figure with the wrong rule.
 */

const { weights, flagThresholds, lookbackPeriods, minPeriodsForScore } = SCORING;

/**
 * The headline figures, explained in three fixed parts.
 *
 * Meaning first, because a reader who does not yet know what a number *is* cannot use a
 * formula. Formula second, bare, so it can be checked against a working paper. Criteria
 * last, because that is where the arguments happen — what counted, what was left out,
 * and where the boundaries between the flags sit.
 *
 * The thresholds are interpolated from config.ts rather than typed out, so a weight
 * changed there changes this sentence at the same moment it changes the arithmetic.
 */
export const KPI_NOTES = {
  itcAtRisk: [
    {
      label: 'Meaning',
      body: 'Credit you have paid your suppliers but cannot claim yet, because it has not reached your GSTR-2B.',
    },
    {
      label: 'Formula',
      body: 'Sum of tax on in-scope purchase invoices with no usable match in GSTR-2B',
    },
    {
      label: 'Criteria',
      body:
        'Counted only where the credit was claimable and the supplier’s deadline has passed. ' +
        'Blocked 17(5) credits, reverse charge, ISD, imports and credit notes are excluded, and so ' +
        'are invoices whose filing window is still open.',
    },
  ],

  expectedCashLoss: [
    {
      label: 'Meaning',
      body: 'The part of the credit at risk that history suggests you will never actually recover.',
    },
    {
      label: 'Formula',
      body: 'ITC at risk × (1 − historical recovery rate)',
    },
    {
      label: 'Criteria',
      body:
        `The recovery rate is this supplier’s own once ${String(RECOVERY.minGapsForSupplierRate)} or more of their past gaps have ` +
        'resolved, and the whole dataset’s otherwise; the row shows which was used. A gap counts as ' +
        'recovered if the invoice appeared in any later period you loaded.',
    },
  ],

  redSuppliers: [
    {
      label: 'Meaning',
      body: 'How many suppliers scored badly enough to need action from you now.',
    },
    {
      label: 'Formula',
      body: `Count of suppliers scoring below ${String(flagThresholds.amber)} out of 100`,
    },
    {
      label: 'Criteria',
      body:
        `Score = match rate ${String(weights.matchRate)}, delay ${String(weights.avgDelayMonths)}, volatility ${String(weights.volatility)}, dispute rate ${String(weights.disputeRate)}. ` +
        `OK ${String(flagThresholds.green)} and above, Watch ${String(flagThresholds.amber)} to ${String(flagThresholds.green - 1)}, At risk below ${String(flagThresholds.amber)}. ` +
        `A supplier with fewer than ${String(minPeriodsForScore)} periods of data is not scored at all.`,
    },
  ],
} as const;

export const EXPLANATIONS = {
  itcAtRisk:
    'ITC at risk = tax on in-scope purchase invoices that have no usable counterpart in GSTR-2B. ' +
    'Blocked credits, reverse charge, ISD, imports and credit notes are excluded, and so are ' +
    'invoices whose filing deadline has not passed yet.',

  expectedCashLoss:
    'Expected cash loss = ITC at risk × (1 − the historical recovery rate). The recovery rate is ' +
    `this supplier's own when at least ${String(RECOVERY.minGapsForSupplierRate)} of their past gaps have resolved, ` +
    'and the whole dataset’s otherwise. Which one was used is shown beside the figure.',

  recoveryBias:
    'A gap counts as recovered if the invoice appeared in any later period you loaded. Older gaps ' +
    'have had more periods in which to resolve than recent ones, so this figure reads slightly ' +
    'pessimistic for the newest month.',

  score:
    `Score out of 100, weighted: match rate ${String(weights.matchRate)}, average delay ${String(weights.avgDelayMonths)}, ` +
    `volatility ${String(weights.volatility)}, dispute rate ${String(weights.disputeRate)}. ` +
    `${String(flagThresholds.green)} and above is OK, ${String(flagThresholds.amber)} to ${String(flagThresholds.green - 1)} is Watch, below ${String(flagThresholds.amber)} is At risk.`,

  matchRate:
    'Match rate = value received on time ÷ total in-scope value, over the scoring window. ' +
    'Credit you rejected or kept pending in IMS is excluded, because that is your decision, not ' +
    'the supplier’s failure.',

  avgDelayMonths:
    'Average delay = value-weighted months late, counted beyond what the supplier is allowed. ' +
    'A quarterly (QRMP) filer who files within their own quarter has a delay of zero.',

  volatility:
    'Volatility = standard deviation of the monthly match rate across the window. A supplier who ' +
    'swings between good and bad months is harder to plan cash around than one who is steadily late.',

  disputeRate:
    'Dispute rate = share of in-scope value in gaps caused by the supplier, plus credit notes they ' +
    'reported that you never recorded.',

  concentration:
    'Concentration = this supplier’s in-scope ITC ÷ total in-scope ITC. A large clean supplier ' +
    'going bad costs more than several small bad ones.',

  insufficientHistory:
    `No score is shown for a supplier with fewer than ${String(minPeriodsForScore)} periods of data. One bad month is ` +
    'not a pattern, and a confident red flag drawn from it would send you to make a phone call you ' +
    'should not make.',

  scoringWindow: `Scores use the most recent ${String(lookbackPeriods)} periods loaded.`,

  deemedAccepted:
    'Records that reached your GSTR-2B and that nobody on your team acted on, so they were accepted automatically when GSTR-3B was filed.',

  attribution:
    'Every gap is attributed to exactly one cause. Only "supplier never reported" and "supplier ' +
    'reported late" affect a supplier’s score; the two IMS causes are your own control finding.',

  pendingAgeing:
    'Days since the record was marked pending in IMS, or since the invoice date if it was never ' +
    'touched.',

  section16_4:
    'Input tax credit for a financial year cannot be claimed after 30 November of the following ' +
    `year. A pending record inside ${String(AGEING.deadlineRedWindowDays)} days of that date is shown red: past it, the credit is ` +
    'not late, it is gone.',

  rejectedCreditNote:
    'Rejecting a credit note in IMS increases the supplier’s liability in their next GSTR-3B. A ' +
    'careless rejection quietly hands them a tax bill they will eventually ask about.',

  matchTiers:
    'Documents are matched in strict order and one-to-one. Tier 1 is GSTIN, invoice number and tax; ' +
    'tier 2 is the same document with a different value; tier 3 is same value and date with a ' +
    'different number. Tiers 1 and 3 count as credit received, tier 2 credits the portal value and ' +
    'puts the shortfall at risk, and tiers 4 and 5 are found-but-not-usable, counted in neither.',

  needsCorrection:
    `Found in GSTR-2B but not usable as it stands (match tiers ${MATCHING.tiersNeedingCorrection.join(' and ')}): reported under a ` +
    'different GSTIN, or under an invoice number close enough to be a typing slip. Counted in ' +
    'neither received credit nor ITC at risk, so neither figure is overstated.',

  notYetDue:
    'The supplier’s deadline to report this invoice has not passed yet, so it is not counted as ' +
    'missing. Quarterly filers have until the end of their quarter.',

  taxHeadMismatch:
    'The document was booked as CGST+SGST and reported as IGST, or the reverse. The credit exists ' +
    'but under the wrong head, which needs a different correction from a missing invoice.',

  outOfScope:
    'Counted and shown, but excluded from ITC at risk and from supplier scoring: there was no ' +
    'credit here to lose, so scoring a supplier down for it would be wrong.',
} as const;

export type ExplanationKey = keyof typeof EXPLANATIONS;
