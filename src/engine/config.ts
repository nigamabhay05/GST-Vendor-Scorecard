/**
 * Every tunable constant in the application.
 *
 * Nothing in this codebase hard-codes a threshold, a weight or a tolerance anywhere
 * else. Two reasons, both practical:
 *
 *   1. A chartered accountant has to be able to defend every number on screen. That is
 *      only possible if the rules are in one readable file rather than scattered
 *      through the arithmetic.
 *   2. Firms disagree about where "amber" starts. Disagreement should be a one-line
 *      edit here, not a hunt through the matching pipeline.
 *
 * The user-facing explanations in `explanations.ts` are generated from these values, so
 * a sentence in the interface cannot drift out of step with the arithmetic behind it.
 */

export const ENGINE_VERSION = '0.1.0';

// ------------------------------------------------------------------- money

export const MONEY = {
  /**
   * Two amounts within this many rupees are treated as equal.
   *
   * A purchase register and the GST portal disagree by a paisa or two constantly:
   * Tally rounds each line, the portal rounds the document total, and both are
   * "right". One rupee absorbs that without absorbing a real difference -- the
   * smallest genuine discrepancy worth a phone call is far larger.
   */
  toleranceRupees: 1,

  /** Characters stripped before parsing a money value from a spreadsheet cell. */
  strippedCharacters: ['₹', ',', ' ', ' ', ' ', 'Rs.', 'Rs', 'INR'],
} as const;

// -------------------------------------------------------------------- dates

export const DATES = {
  /**
   * Tier 3 matches on taxable value and an invoice date within this many days.
   *
   * Suppliers and buyers routinely book the same document a day or two apart -- goods
   * dispatched on the 31st, received and booked on the 2nd. Three days covers the
   * usual gap without letting two genuinely different invoices of the same value
   * collide.
   */
  tier3DateToleranceDays: 3,

  /** The Indian financial year runs 1 April to 31 March. */
  financialYearStartMonth: 4,

  /**
   * Section 16(4): ITC for a financial year may be claimed until 30 November following
   * the end of that year. Pending IMS records must be acted on before this date or the
   * credit is simply lost.
   */
  section16_4DeadlineMonth: 11,
  section16_4DeadlineDay: 30,

  /** Excel's 1900 date system epoch, used to convert serial numbers. */
  excelEpochUtcDays: 25569,
} as const;

// ---------------------------------------------------------------- matching

export const MATCHING = {
  /**
   * Tier 5 accepts a normalised invoice number within this edit distance when GSTIN and
   * value already agree. Two is enough for a transposition or a dropped character;
   * three starts matching genuinely different invoice numbers.
   */
  tier5MaxLevenshtein: 2,

  /**
   * Tiers whose result counts as credit actually received.
   * Tier 3 is included: the invoice number differs, but the credit did arrive.
   */
  tiersCountedAsReceived: [1, 3] as const,

  /** Tier 2 credits the 2B value and puts only the shortfall at risk. */
  tiersCountedAsPartial: [2] as const,

  /**
   * Tiers that found something unusable as it stands. Excluded from matched value *and*
   * from at-risk, so neither total is overstated, and reported as their own category.
   */
  tiersNeedingCorrection: [4, 5] as const,
} as const;

// ------------------------------------------------------------------ scoring

export const SCORING = {
  /**
   * How many periods the score looks back over. Six months is long enough for a
   * pattern to be visible and short enough that a supplier who has genuinely fixed
   * their filing stops being punished for last year.
   */
  lookbackPeriods: 6,

  /**
   * Below this many periods of data a supplier gets no score at all, only
   * "Insufficient history".
   *
   * This matters more than it looks. A single month in which a supplier filed late --
   * or in which the buyer's own staff mis-keyed a GSTIN -- would otherwise produce a
   * confident red flag, someone would make a phone call based on it, and the tool would
   * lose the room. Three periods is the minimum at which "pattern" means anything.
   */
  minPeriodsForScore: 3,

  /** Weights out of 100. Match rate dominates because it is the outcome that costs cash;
   *  the other three explain *how* a supplier fails and how predictable it is. */
  weights: {
    matchRate: 45,
    avgDelayMonths: 25,
    volatility: 15,
    disputeRate: 15,
  },

  /** Score bands. Green is deliberately demanding: 80 is "no action needed". */
  flagThresholds: {
    green: 80,
    amber: 50,
  },

  /**
   * Delay scaling: zero months scores full points, and this many months scores zero.
   * Three months is the point at which credit is at genuine risk of running past the
   * section 16(4) window rather than merely being annoying.
   */
  delayMonthsForZeroPoints: 3,

  /**
   * Volatility scaling: a standard deviation of monthly match rate at or above this
   * scores zero. 0.30 means a supplier swinging by roughly a third of their volume
   * month to month is unpredictable enough to plan around, whatever their average.
   */
  volatilityForZeroPoints: 0.3,

  /**
   * Dispute rate scaling: a rate at or above this scores zero. Set below 1.0 because a
   * supplier disputing a quarter of their value by tax head or credit note is already a
   * serious problem; the difference between 25% and 100% does not need to be graded.
   */
  disputeRateForZeroPoints: 0.25,
} as const;

// -------------------------------------------------------- expected cash loss

export const RECOVERY = {
  /**
   * A gap counts as recovered when the invoice appears in a later loaded period.
   *
   * Known bias, stated in the interface and in ASSUMPTIONS.md rather than hidden: an
   * old gap had more periods in which to resolve than a recent one, so the rate reads
   * slightly pessimistic on the newest month and expected cash loss there reads high.
   */
  countRecoveredInAnyLaterPeriod: true,

  /**
   * Minimum resolved gaps before a supplier's own recovery rate is used instead of the
   * global one. Under five, the rate is noise dressed up as a measurement.
   */
  minGapsForSupplierRate: 5,

  /**
   * Fallback when there is no history at all to compute a rate from -- neither the
   * supplier's nor the dataset's. Deliberately pessimistic: assuming most missing
   * credit eventually turns up is the assumption that produces a nasty surprise.
   */
  defaultGlobalRecoveryRate: 0.5,
} as const;

// --------------------------------------------------------- filing frequency

export const FILING = {
  /** Used when there is no supplier master and no usable filing pattern. */
  defaultFrequency: 'monthly' as const,

  /**
   * QRMP inference, used only when the supplier master is absent or silent. If a
   * supplier's GSTR-1 filing dates land in at most this many distinct months per
   * quarter, across at least `inferenceMinQuarters` quarters, they are treated as
   * quarterly -- flagged low confidence, because inferring this wrongly changes a score.
   */
  inferenceMaxFilingMonthsPerQuarter: 1,
  inferenceMinQuarters: 2,
} as const;

// ------------------------------------------------------------ pending ageing

export const AGEING = {
  /** Bucket upper bounds in days. The final bucket is everything beyond the last bound. */
  bucketBoundsDays: [30, 60, 90] as const,

  /**
   * Inside this many days of the section 16(4) deadline, a pending record is red.
   * Sixty days is roughly the last point at which a supplier can still be chased, a
   * correction filed and the credit claimed without heroics.
   */
  deadlineRedWindowDays: 60,

  /** Amber is the warning shot: enough time to act, not enough to forget about it. */
  deadlineAmberWindowDays: 120,
} as const;

// ------------------------------------------------------------ scope and risk

export const SCOPE = {
  /**
   * Text found in a register's document-type, nature-of-supply or remarks column that
   * places a document outside IMS scope. Matched case-insensitively as substrings,
   * because no two Tally exports word these the same way.
   */
  reverseChargeMarkers: ['reverse charge', 'rcm', 'sec 9(3)', 'sec 9(4)', 'u/s 9(3)'],
  isdMarkers: ['isd', 'input service distributor'],
  importOfServicesMarkers: ['import of service', 'import services', 'oidar'],
  posRestrictedMarkers: ['pos restricted', 'place of supply restricted', 'pos-restricted'],
  blocked17_5Markers: ['17(5)', '17-5', 'blocked', 'ineligible', 'not eligible'],
} as const;

// ------------------------------------------------------- suggested actions

export const ACTION_THRESHOLDS = {
  /**
   * A supplier above this share of total ITC is called out by name in the suggested
   * action even when their score is acceptable, because concentration is a risk in its
   * own right: one large clean supplier going bad hurts more than five small bad ones.
   */
  highConcentration: 0.1,

  /** Expected cash loss above this is worth a partner's attention, not a clerk's. */
  materialCashLossRupees: 50_000,

  /**
   * Credit awaiting the user's own decision -- rejected or held in IMS -- above which
   * the supplier is flagged "Your action" rather than being allowed to show OK.
   *
   * Set deliberately low. The cost of flagging a small one is a glance; the cost of
   * missing a large one is the credit itself.
   */
  materialUserActionRupees: 25_000,
} as const;

/**
 * Attribution thresholds.
 */
export const ATTRIBUTION = {
  /**
   * How many of a supplier's invoices must have arrived on time before their other
   * gaps can be read as a wrong recipient GSTIN rather than as non-filing.
   *
   * Two is enough to establish that the supplier files, and low enough that a small
   * supplier is not excluded from the check by volume alone.
   */
  minOnTimeSiblingsForWrongGstin: 2,

  /**
   * How reliable a supplier must be before non-filing stops being the likelier reading.
   *
   * A supplier who misses a third of their filings is simply a poor filer, and telling
   * the user to go and ask about recipient GSTINs would send them down the wrong road.
   * The hypothesis is only worth raising about a supplier whose record is otherwise
   * strong -- that is what makes the missing few anomalous rather than typical.
   */
  minCleanShareForWrongGstin: 0.7,

  /**
   * How many distinct periods the unexplained documents must span.
   *
   * One invoice going astray in one month is an ordinary slip. The same thing happening
   * across several months, while everything else from that supplier arrives on time, is
   * the signature of a wrong recipient GSTIN sitting in their billing master.
   */
  minAffectedPeriodsForWrongGstin: 2,
} as const;

// -------------------------------------------------------- parsing behaviour

export const PARSING = {
  /**
   * How many rows from the top of a sheet to search for the real header row. Tally and
   * portal exports routinely carry a title block, a GSTIN line and a blank row above
   * the actual column names.
   */
  maxHeaderSearchRows: 25,

  /** Minimum share of a candidate header row's cells that must match a known synonym
   *  before it is accepted as the header row. */
  headerDetectionMinHitRate: 0.3,

  /** Rows shown in the mapping screen's live preview. */
  previewRows: 5,

  /** Normalised edit distance above which a header is not considered a fuzzy match. */
  headerFuzzyMaxDistance: 2,
} as const;

/** Convenience re-export so callers can take one import when they need several. */
export const CONFIG = {
  ENGINE_VERSION,
  MONEY,
  DATES,
  MATCHING,
  SCORING,
  RECOVERY,
  FILING,
  AGEING,
  SCOPE,
  ACTION_THRESHOLDS,
  ATTRIBUTION,
  PARSING,
} as const;
