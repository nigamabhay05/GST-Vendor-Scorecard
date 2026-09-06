/**
 * Domain types for the Vendor GST Compliance Scorecard engine.
 *
 * This file is the single source of truth. Nothing else in the codebase should define a
 * shape that describes an invoice, a supplier or a result -- if a new field is needed,
 * it is added here first.
 *
 * Two conventions run through the whole file:
 *
 *   - Money is rupees as a `number`. Comparisons use the tolerance in config.ts, never
 *     `===`, because a register and the portal disagree by a rounding paisa constantly.
 *   - Dates are `DateOnly` strings, never `Date` objects. A `Date` carries a timezone,
 *     and an invoice dated 31 March that silently becomes 30 March in a different
 *     timezone lands in the wrong financial year. There is no correct timezone for a
 *     tax document date, so none is applied.
 */

// ---------------------------------------------------------------- primitives

/** A calendar date with no time and no timezone: `"YYYY-MM-DD"`. */
export type DateOnly = string;

/** A tax period: `"YYYY-MM"`. `"2026-04"` is April 2026. */
export type PeriodKey = string;

/** A 15-character GSTIN, uppercased. The type does not imply it is valid. */
export type Gstin = string;

/** Characters 3-12 of a GSTIN: the supplier's PAN. Used by match tier 4. */
export type PanKey = string;

/** Rupees. Not paise. */
export type Rupees = number;

/** How often the supplier files GSTR-1. Drives the QRMP on-time window. */
export type FilingFrequency = 'monthly' | 'quarterly';

/**
 * Where a supplier's filing frequency came from. Surfaced in the UI because an
 * inferred frequency that turns out to be wrong changes a supplier's score, and the
 * user is entitled to know which figures rest on a guess.
 */
export type FilingFrequencySource = 'master' | 'inferred' | 'default';

export type Confidence = 'high' | 'low';

/**
 * A credit note is never treated as an invoice. Debit notes increase ITC and are
 * matched like invoices; credit notes reduce it and are tracked separately.
 */
export type DocumentType = 'invoice' | 'debit_note' | 'credit_note';

/** The action a recipient took in the Invoice Management System. */
export type ImsAction = 'Accept' | 'Reject' | 'Pending' | 'NoAction';

/** The four input file kinds. Only the first two are required. */
export type FileKind = 'purchaseRegister' | 'gstr2b' | 'supplierMaster' | 'imsLog';

// ------------------------------------------------------------------ tax heads

/** The tax breakdown of one document. Kept as separate heads so a CGST+SGST document
 *  reported as IGST can be detected -- that is its own finding, not a mismatch in value. */
export interface TaxAmounts {
  taxable: Rupees;
  cgst: Rupees;
  sgst: Rupees;
  igst: Rupees;
  cess: Rupees;
}

/** Which heads a document actually carries. Compared across books and portal. */
export type TaxHead = 'intra' | 'inter' | 'none' | 'mixed';

// -------------------------------------------------------------------- scope

/**
 * Why a document was excluded from at-risk totals and from supplier scoring.
 *
 * Scoring a supplier down over ITC nobody was ever going to claim is the commonest
 * way a tool like this loses credibility with the people who have to defend it, so
 * exclusions are counted and shown rather than dropped.
 */
export type ScopeExclusionReason =
  | 'blocked_17_5'
  | 'reverse_charge'
  | 'isd'
  | 'import_of_services'
  | 'pos_restricted'
  | 'credit_note'
  | 'itc_ineligible_flag';

export interface ScopeClassification {
  inScope: boolean;
  reason: ScopeExclusionReason | null;
}

// ------------------------------------------------------------- parsed inputs

/** One row of the buyer's purchase register, after normalisation. */
export interface BookRow {
  /** Stable id, `"book:<period>:<sourceRow>"`. Referenced by match results. */
  id: string;
  /** 1-based row number in the source file, so Data Health can point at it. */
  sourceRow: number;
  /** The period the user tagged this file with. */
  period: PeriodKey;

  supplierName: string;
  supplierGstin: Gstin | null;
  panKey: PanKey | null;

  invoiceNumber: string;
  /** See normalize/invoiceNumber.ts. `INV/2026/001` and `INV-2026-1` share this. */
  invoiceNumberNormalized: string;
  invoiceDate: DateOnly | null;

  docType: DocumentType;
  tax: TaxAmounts;

  /** The register's own "ITC eligible" flag, when the export has one. */
  itcEligibleFlag: boolean | null;
  scope: ScopeClassification;
}

/** Which sheet of the GSTR-2B workbook a row came from. */
export type Gstr2bSection = 'b2b' | 'b2ba' | 'cdnr' | 'cdnra' | 'impg' | 'isd' | 'other';

/** One row of GSTR-2B, after normalisation. */
export interface Portal2bRow {
  id: string;
  sourceRow: number;
  sourceSection: Gstr2bSection;
  /** The 2B return period this row was read from -- i.e. when the credit arrived. */
  period: PeriodKey;

  supplierName: string;
  supplierGstin: Gstin | null;
  panKey: PanKey | null;

  invoiceNumber: string;
  invoiceNumberNormalized: string;
  invoiceDate: DateOnly | null;

  docType: DocumentType;
  tax: TaxAmounts;

  /**
   * The supplier's GSTR-1 filing date.
   *
   * This is the single most important field in the whole input set. It is what makes
   * the tool forward-looking rather than another reconciliation report: supplier delay
   * can be measured from it directly, with no external data source and no API.
   */
  gstr1FilingDate: DateOnly | null;

  itcAvailable: boolean | null;
  itcUnavailableReason: string | null;

  /** Amendment rows supersede the document they amend; the latest one wins. */
  isAmendment: boolean;
  amendsInvoiceNumberNormalized: string | null;
  /** Set on the row that was superseded, pointing at the amendment that replaced it. */
  supersededById: string | null;

  reverseCharge: boolean;
}

/** One row of the optional supplier master. Turns a report into a workflow. */
export interface SupplierMasterRow {
  sourceRow: number;
  supplierName: string;
  gstin: Gstin | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number | null;
  filingFrequency: FilingFrequency | null;
}

/** One row of the optional IMS action log. Without this, gaps are `unattributed`. */
export interface ImsLogRow {
  id: string;
  sourceRow: number;
  period: PeriodKey;

  gstin: Gstin | null;
  invoiceNumber: string;
  invoiceNumberNormalized: string;
  invoiceDate: DateOnly | null;
  value: Rupees;

  action: ImsAction;
  actionDate: DateOnly | null;
  remark: string | null;
  recordType: DocumentType;
}

// ------------------------------------------------------------------ matching

export type MatchTier = 1 | 2 | 3 | 4 | 5;

/** The user-facing outcome of matching one document. Named as a CA would name it. */
export type MatchStatus =
  | 'matched'
  | 'value_mismatch'
  | 'invoice_number_mismatch'
  | 'gstin_state_mismatch'
  | 'probable_match'
  | 'missing_in_2b'
  | 'missing_in_books';

/**
 * How a match result is treated when money is added up. Separate from `MatchStatus`
 * because the label a user reads and the arithmetic are different questions: a tier-3
 * result reads "Invoice number mismatch" but the credit did arrive.
 *
 *   received         tiers 1 and 3 -- credit is in 2B and usable
 *   partial          tier 2 -- the 2B value is received, the shortfall is at risk
 *   needs_correction tiers 4 and 5 -- found, but not usable as it stands. Counted in
 *                    neither matched value nor at-risk, so no total is overstated in
 *                    either direction; reported as its own category instead.
 *   at_risk          no counterpart in 2B at all
 *   not_applicable   missing in books, or excluded from scope
 */
export type CreditTreatment =
  | 'received'
  | 'partial'
  | 'needs_correction'
  | 'at_risk'
  | 'not_applicable';

/**
 * Why a gap exists. Exactly one applies to each gap.
 *
 * Only `supplier_never_reported` and `supplier_reported_late` affect a supplier's
 * score. The two `recipient_*` values are the buyer's own internal control findings and
 * are reported as such -- the tool must never blame a supplier for the buyer's error.
 */
export type Attribution =
  | 'supplier_never_reported'
  | 'supplier_reported_late'
  | 'recipient_rejected'
  | 'recipient_kept_pending'
  | 'deemed_accepted'
  | 'unattributed';

export interface MatchResult {
  id: string;
  status: MatchStatus;
  /** Null for the two unmatched statuses; set for every tiered match. */
  tier: MatchTier | null;
  creditTreatment: CreditTreatment;

  bookRowId: string | null;
  portalRowId: string | null;

  supplierName: string;
  supplierGstin: Gstin | null;
  panKey: PanKey | null;

  invoiceNumber: string;
  /** The same number after normalisation, so lookups need not redo the work. */
  invoiceNumberNormalized: string;
  invoiceDate: DateOnly | null;
  docType: DocumentType;

  /** Period the document should have appeared in, derived from the invoice date. */
  expectedPeriod: PeriodKey | null;
  /** Period of the GSTR-2B it actually appeared in. */
  actualPeriod: PeriodKey | null;
  /** Whole months late. Null when it never arrived, or when the period is unknown. */
  delayMonths: number | null;
  /**
   * Months late *beyond what this supplier is allowed*. Zero for a quarterly filer who
   * files within their quarter. This, not delayMonths, is what scoring uses -- otherwise
   * a QRMP supplier is penalised for using a scheme the law offers them.
   */
  excessDelayMonths: number | null;
  /**
   * The document has not appeared in GSTR-2B, but its on-time window has not closed yet
   * -- typically a quarterly filer whose quarter is still open at the last loaded period.
   * Not yet due is not the same as missing: these are excluded from ITC at risk and from
   * the match-rate denominator, or every QRMP supplier would be flagged every quarter.
   */
  notYetDue: boolean;
  /** Respects the supplier's filing frequency: a quarterly filer within its own
   *  quarter is on time. Null when it never arrived. */
  onTime: boolean | null;

  /** Books show CGST+SGST and 2B shows IGST, or the reverse. Its own flag, not a gap. */
  taxHeadMismatch: boolean;
  booksTaxHead: TaxHead;
  portalTaxHead: TaxHead;

  /** Already net of the 2B value for a tier-2 partial. */
  taxAtRisk: Rupees;
  taxReceived: Rupees;
  /**
   * Tax found in GSTR-2B that is not usable as it stands: match tiers 4 and 5.
   *
   * Deliberately kept out of both `taxReceived` and `taxAtRisk`, so neither headline
   * figure is overstated. But the document itself is real and belongs to a period, so
   * the value is carried here rather than being dropped -- without it a supplier whose
   * every document matched at tier 4 has zero value in every period, and the scorecard
   * concludes it has no history at all.
   */
  taxNeedsCorrection: Rupees;

  attribution: Attribution;
  inScope: boolean;
  scopeReason: ScopeExclusionReason | null;

  /** Levenshtein distance on normalised invoice numbers, for tier 5 review. */
  invoiceNumberDistance: number | null;
}

// --------------------------------------------------------------- data health

export type DataHealthSeverity = 'info' | 'warning' | 'blocking';

export interface FileReadSummary {
  kind: FileKind;
  fileName: string;
  period: PeriodKey | null;
  /** Rows below the detected header row. */
  rowsRead: number;
  rowsAccepted: number;
  rowsDropped: number;
  headerRowIndex: number;
  sections?: Partial<Record<Gstr2bSection, number>>;
}

/** A row the engine could not use at all, with the reason, so nothing vanishes. */
export interface DroppedRow {
  kind: FileKind;
  fileName: string;
  sourceRow: number;
  reason: string;
  excerpt: string;
}

export interface GstinIssue {
  kind: FileKind;
  fileName: string;
  sourceRow: number;
  supplierName: string;
  value: string;
  /** A failed check digit is a warning, never a rejection: a bug in the checksum
   *  function must not be able to silently drop a supplier's data. */
  problem: 'blank' | 'malformed' | 'check_digit';
}

export interface UnparseableDate {
  kind: FileKind;
  fileName: string;
  sourceRow: number;
  column: string;
  value: string;
}

/**
 * A date column where every value is <= 12 in both positions, so `DD/MM` and `MM/DD`
 * are indistinguishable. The engine refuses to guess; the user is asked.
 */
export interface AmbiguousDateColumn {
  kind: FileKind;
  fileName: string;
  column: string;
  sampleValues: string[];
  affectedRows: number;
  /** Set once the user answers on the Data Health screen. */
  resolvedAs: 'DMY' | 'MDY' | null;
}

/**
 * Two distinct book invoices from one supplier in one period that normalise to the
 * same key. They are not merged -- both are flagged and matched on value and date.
 */
export interface NormalizationCollision {
  supplierGstin: Gstin | null;
  supplierName: string;
  period: PeriodKey;
  normalizedKey: string;
  originalInvoiceNumbers: string[];
  rowIds: string[];
}

export interface DuplicateInvoiceGroup {
  kind: FileKind;
  supplierGstin: Gstin | null;
  supplierName: string;
  invoiceNumber: string;
  rowIds: string[];
  identicalValues: boolean;
}

export interface ScopeExclusionSummary {
  reason: ScopeExclusionReason;
  rows: number;
  taxableValue: Rupees;
  taxValue: Rupees;
}

export interface DataHealthReport {
  files: FileReadSummary[];
  gstinIssues: GstinIssue[];
  unparseableDates: UnparseableDate[];
  ambiguousDateColumns: AmbiguousDateColumn[];
  /** Fields where more than one column could have been the source. */
  ambiguousColumnMappings: AmbiguousColumnMapping[];
  normalizationCollisions: NormalizationCollision[];
  duplicateInvoices: DuplicateInvoiceGroup[];
  scopeExclusions: ScopeExclusionSummary[];
  droppedRows: DroppedRow[];
  /** True when an unresolved ambiguous date column makes the results unsafe to trust.
   *  The Data Health screen cannot be passed while this holds. */
  blocking: boolean;
}

/**
 * What a parser returns. Every parser reports its findings alongside its rows rather
 * than throwing: a file with three bad dates in it is still a file worth analysing, and
 * the user needs to see the three bad dates rather than an error page.
 */
export interface ParseOutcome<T> {
  rows: T[];
  mapping: FileMapping;
  summary: FileReadSummary;
  gstinIssues: GstinIssue[];
  unparseableDates: UnparseableDate[];
  ambiguousDateColumns: AmbiguousDateColumn[];
  droppedRows: DroppedRow[];
  /** Named limitations hit while reading this file, surfaced verbatim in the UI. */
  notImplemented?: string[];
}

// ------------------------------------------------------------------- scoring

/** The four raw measures behind a supplier score, in their natural units. */
export interface ScoreComponents {
  /** Value received on time divided by total in-scope book value. 0..1. */
  matchRate: number;
  /** Value-weighted mean delay in months. */
  avgDelayMonths: number;
  /**
   * Population standard deviation of the monthly match rate. 0..1.
   *
   * Null when fewer than two periods have data: with one observation there is no
   * spread to measure, and reporting 0.00 would claim a steadiness nothing supports.
   */
  volatility: number | null;
  /** Share of value in gaps attributed to supplier error, plus credit note issues. 0..1. */
  disputeRate: number;
}

/** The same four measures scaled to 0..100 before weighting, for transparency. */
/** Null where the underlying component could not be measured; see ScoreComponents. */
export type ScoreComponentPoints = Record<keyof ScoreComponents, number | null>;

/**
 * What the reader should do about this supplier.
 *
 * `user_action` is deliberately not a severity between amber and red. It answers a
 * different question: the supplier's own behaviour may be spotless, but credit is
 * sitting on a decision only the user can make. A flag is the one thing most readers
 * scan, and showing OK beside a six-figure gap -- however defensible the score -- is
 * misleading. This state exists so that never happens.
 */
export type SupplierFlag =
  | 'green'
  | 'amber'
  | 'red'
  | 'user_action'
  | 'insufficient_history';

/** One document the user rejected in IMS, with the reason they gave at the time. */
export interface DeclinedCreditRow {
  supplierKey: string;
  supplierName: string;
  supplierGstin: Gstin | null;
  invoiceNumber: string;
  invoiceDate: DateOnly | null;
  period: PeriodKey | null;
  taxValue: Rupees;
  /** The IMS remark, verbatim. The whole point is that a human reads this. */
  remark: string | null;
  actionDate: DateOnly | null;
}

/**
 * Credit the user declined, gathered for review.
 *
 * No headline rupee figure is attached to this anywhere in the interface. Whether a
 * rejection was correct is a question about goods received and duplicates booked, which
 * this tool cannot see -- so it lists the documents and the reasons and leaves the
 * judgement to someone who can.
 */
export interface DeclinedCreditReport {
  rows: DeclinedCreditRow[];
  count: number;
  /** Total of the listed documents. Shown as a review workload, never as exposure. */
  taxValue: Rupees;
}

/**
 * Which recovery rate was used for `expectedCashLoss`, and how much history stands
 * behind it. Always shown: an expected loss computed off a global fallback is a much
 * weaker claim than one computed off the supplier's own record, and the user has to be
 * able to tell them apart.
 */
export interface RecoveryRateBasis {
  rate: number;
  source: 'supplier' | 'global';
  /** Number of resolved gaps the rate was computed from. */
  sampleSize: number;
}

export interface MonthlyMatchRate {
  period: PeriodKey;
  /** Null when the supplier had no in-scope book value in that period. */
  matchRate: number | null;
  inScopeValue: Rupees;
}

export interface SupplierContact {
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number | null;
}

export interface SupplierScorecardEntry {
  /** Suppliers are keyed by GSTIN where present, else by normalised name. */
  key: string;
  gstin: Gstin | null;
  panKey: PanKey | null;
  name: string;

  periodsWithData: number;
  /** Null when `flag` is `insufficient_history`. A confident red flag off one month of
   *  data is worse than no flag at all. */
  score: number | null;
  flag: SupplierFlag;

  components: ScoreComponents;
  componentPoints: ScoreComponentPoints;

  itcAtRisk: Rupees;
  /**
   * Value found in GSTR-2B but not usable as it stands (match tiers 4 and 5).
   * Counted in neither matched value nor at-risk, so it is carried separately rather
   * than disappearing from the supplier entirely.
   */
  needsCorrectionValue: Rupees;
  /**
   * Credit the user rejected in IMS.
   *
   * Excluded from both ITC at risk and expected cash loss. The supplier filed on time,
   * so there is no filing behaviour for a recovery rate to model; and most rejections
   * are correct -- goods never received, duplicate already booked -- so the credit was
   * never claimable and reporting it as a loss overstates exposure. It is reported on
   * its own, with each remark, for a human to sort the correct ones from the mistakes.
   */
  declinedValue: Rupees;
  /** The GSTIN on file passes its own check digit. False means our data is wrong, not theirs. */
  booksGstinValid: boolean;
  /** Their other invoices filed on time, yet these never reached any 2B or IMS. */
  wrongRecipientGstinSuspected: boolean;
  expectedCashLoss: Rupees;
  recoveryBasis: RecoveryRateBasis;
  /** This supplier's in-scope ITC as a share of all in-scope ITC. 0..1. */
  concentration: number;

  filingFrequency: FilingFrequency;
  filingFrequencySource: FilingFrequencySource;
  filingFrequencyConfidence: Confidence;

  monthlyMatchRate: MonthlyMatchRate[];
  /** Counts by attribution, so the drill-down can show supplier vs recipient causes. */
  attributionCounts: Record<Attribution, number>;
  attributionValue: Record<Attribution, Rupees>;

  suggestedAction: string;
  contact: SupplierContact | null;
  matchResultIds: string[];
}

// ------------------------------------------------------------ pending ageing

export type AgeingBucket = '0-30' | '31-60' | '61-90' | '90+';

/** How close a pending record is to the date its credit stops being claimable. */
export type DeadlineFlag = 'ok' | 'amber' | 'red' | 'expired';

export interface PendingAgeingRow {
  imsRowId: string;
  supplierName: string;
  supplierGstin: Gstin | null;
  invoiceNumber: string;
  invoiceDate: DateOnly | null;
  value: Rupees;
  taxValue: Rupees;

  /** Days since the IMS action date, or the invoice date when no action date exists. */
  ageDays: number;
  bucket: AgeingBucket;

  /** 30 November following the 31 March end of the invoice's financial year. */
  section16_4Deadline: DateOnly;
  daysToDeadline: number;
  deadlineFlag: DeadlineFlag;
}

export interface PendingAgeingReport {
  rows: PendingAgeingRow[];
  byBucket: Record<AgeingBucket, { rows: number; taxValue: Rupees }>;
  /** The reference date all ageing was computed against, so the report is reproducible. */
  asOf: DateOnly;
  totalTaxValue: Rupees;
  atRiskOfExpiryTaxValue: Rupees;
}

// -------------------------------------------------------------- credit notes

/**
 * Credit notes rejected in IMS get their own high-attention category: rejecting a
 * credit note increases the *supplier's* liability in their next GSTR-3B, so a careless
 * rejection quietly hands a supplier a tax bill they will eventually ask about.
 */
export interface CreditNoteReport {
  total: { count: number; taxValue: Rupees };
  rejected: {
    count: number;
    taxValue: Rupees;
    rows: Array<{
      supplierName: string;
      supplierGstin: Gstin | null;
      invoiceNumber: string;
      invoiceDate: DateOnly | null;
      taxValue: Rupees;
      remark: string | null;
    }>;
  };
  accepted: { count: number; taxValue: Rupees };
  pending: { count: number; taxValue: Rupees };
}

// -------------------------------------------------------------------- output

export interface HeadlineKpis {
  totalItcAtRisk: Rupees;
  expectedCashLoss: Rupees;
  redSupplierCount: number;
  /** Suppliers whose gap is awaiting the user own decision, not the supplier's. */
  userActionSupplierCount: number;
  /** redSupplierCount + userActionSupplierCount. What the KPI strip shows. */
  suppliersNeedingAttention: number;
  /** Share of 2B records that were deemed accepted rather than actively accepted. 0..1. */
  deemedAcceptedShare: number;
  deemedAcceptedCount: number;
  totalInScopeItc: Rupees;
  suppliersScored: number;
  suppliersInsufficientHistory: number;
}

export interface AttributionSplitEntry {
  attribution: Attribution;
  count: number;
  taxValue: Rupees;
  /** True for the two buckets that are the buyer's own control finding. */
  isRecipientCause: boolean;
}

export interface DeemedAcceptanceReport {
  count: number;
  taxValue: Rupees;
  share: number;
  /** Null when no IMS log was supplied at all -- in which case nothing can be said. */
  imsLogSupplied: boolean;
  periodsWithImsLog: PeriodKey[];
}

export interface AnalysisMeta {
  /** Reference date for every ageing and deadline calculation. */
  asOf: DateOnly;
  periods: PeriodKey[];
  /** The scoring window actually used, which may be shorter than the configured one. */
  scoringPeriods: PeriodKey[];
  buyerGstin: Gstin | null;
  isSampleData: boolean;
  engineVersion: string;
  /** Milliseconds spent in the engine, for the "under three seconds" claim. */
  runtimeMs: number;
}

/**
 * Everything the UI is allowed to render. If a number appears on screen, it is a field
 * of this object -- the UI never computes a business figure.
 */
export interface AnalysisResult {
  meta: AnalysisMeta;
  dataHealth: DataHealthReport;
  kpis: HeadlineKpis;
  suppliers: SupplierScorecardEntry[];
  matches: MatchResult[];
  attributionSplit: AttributionSplitEntry[];
  deemedAcceptance: DeemedAcceptanceReport;
  pendingAgeing: PendingAgeingReport;
  creditNotes: CreditNoteReport;
  /** Credit the user rejected in IMS, listed for review. Never counted as exposure. */
  declinedCredit: DeclinedCreditReport;
  outOfScope: ScopeExclusionSummary[];
  followUpEmails: FollowUpEmail[];
  /** What the parsers made of each file header, so the mapping screen can show and
   *  correct it. The UI never detects columns itself. */
  mappings: FileMapping[];

  /**
   * Capabilities that are deliberately not implemented, in the user's words.
   * The UI renders this list rather than pretending: no placeholder numbers, ever.
   */
  notImplemented: string[];
}

export interface FollowUpEmail {
  supplierKey: string;
  supplierName: string;
  to: string | null;
  subject: string;
  body: string;
}

// ----------------------------------------------------------- column mapping

/** Confidence in an auto-detected header match. `none` means the user must choose. */
export type MappingConfidence = 'exact' | 'fuzzy' | 'none';

/**
 * The user's answers to ambiguous date columns, keyed `"<fileName>::<columnHeader>"`.
 * Only consulted when a column's own contents prove nothing either way.
 */
export type SlashDateFormatAnswers = Record<string, 'DMY' | 'MDY'>;

export interface FieldMapping {
  /** Canonical engine field name, e.g. `supplierGstin`. */
  field: string;
  /** Human label shown in the mapping table. */
  label: string;
  /** The header text in the user's file, once chosen. */
  sourceHeader: string | null;
  confidence: MappingConfidence;
  required: boolean;
  /** One-line statement of what the field is for, shown beside the row. */
  hint: string;
  /**
   * Other headers in the same file that also looked like this field.
   *
   * A Tally register carrying both `Voucher No.` (the buyer's internal number) and
   * `Invoice No.` (the supplier's, which is what reaches GSTR-2B) is the case this
   * exists for. Picking the wrong one costs nothing visible -- matching simply stops
   * finding anything -- so the runner-up is always named rather than discarded.
   */
  alternatives: string[];
}

/**
 * A field that more than one column could have filled.
 *
 * Reported in Data Health because the failure is silent: the analysis completes, the
 * figures look plausible, and every one of them is wrong.
 */
export interface AmbiguousColumnMapping {
  kind: FileKind;
  fileName: string;
  /** Canonical engine field name. */
  field: string;
  label: string;
  chosenHeader: string;
  alternatives: string[];
}

export interface FileMapping {
  kind: FileKind;
  fileName: string;
  headerRowIndex: number;
  availableHeaders: string[];
  fields: FieldMapping[];
  /** First few parsed rows, for the live preview. */
  preview: Array<Record<string, string>>;
}

// ------------------------------------------------------------ engine inputs

/** A file handed to the engine, already read into memory. Never a path or a URL. */
export interface InputFile {
  kind: FileKind;
  fileName: string;
  /** Required for register, 2B and IMS files; ignored for the supplier master. */
  period: PeriodKey | null;
  /** Raw bytes for Excel, or text for CSV. */
  content: ArrayBuffer | string;
  /** Set when the user has confirmed a mapping; auto-detected otherwise. */
  mapping?: FileMapping;
}

export interface AnalysisInputs {
  files: InputFile[];
  buyerGstin: Gstin | null;
  /** Reference date for ageing and deadlines. Explicit so runs are reproducible. */
  asOf: DateOnly;
  isSampleData: boolean;
  /** User answers to ambiguous date columns, keyed `"<fileName>::<column>"`. */
  dateFormatAnswers?: Record<string, 'DMY' | 'MDY'>;
  /** User-editable additions to the blocked-credit list, by GSTIN or supplier name. */
  extraBlockedSuppliers?: string[];
}

// ------------------------------------------------------------- project file

/**
 * The saved project file. This is the *only* persistence in the application: the user
 * presses "Save project", a JSON file is downloaded to their machine, and nothing is
 * written to localStorage, sessionStorage or IndexedDB at any point.
 */
export interface ProjectFile {
  formatVersion: 1;
  savedAt: string;
  buyerGstin: Gstin | null;
  asOf: DateOnly;
  isSampleData: boolean;
  /** Retained so a reloaded project does not ask the user to map columns again. */
  mappings: FileMapping[];
  dateFormatAnswers: Record<string, 'DMY' | 'MDY'>;
  extraBlockedSuppliers: string[];
  /** The parsed rows, so a project reloads without the original spreadsheets. */
  data: {
    bookRows: BookRow[];
    portalRows: Portal2bRow[];
    supplierMaster: SupplierMasterRow[];
    imsRows: ImsLogRow[];
  };
}

// ------------------------------------------------------------ worker protocol

export type WorkerRequest =
  | { type: 'run'; requestId: string; inputs: AnalysisInputs }
  | { type: 'runFromProject'; requestId: string; project: ProjectFile };

export type WorkerResponse =
  | { type: 'progress'; requestId: string; stage: string; fraction: number }
  | { type: 'result'; requestId: string; result: AnalysisResult }
  /** Failures are structured results, never swallowed and never a blank screen. */
  | { type: 'error'; requestId: string; message: string; stage: string; detail?: string };
