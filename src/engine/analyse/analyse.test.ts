import { describe, expect, it } from 'vitest';
import type { ImsLogRow, MatchResult, SupplierMasterRow } from '../types';
import {
  attributeResult,
  buildAttributionSplit,
  isRecipientCause,
  isSupplierFault,
  suspectsWrongRecipientGstin,
  type AttributionContext,
} from './attribution';
import { bucketForAge, buildPendingAgeing, deadlineFlagFor } from './pendingAgeing';
import {
  flagForScore,
  inferFilingFrequency,
  populationStdDev,
  recoveryRateFor,
  resolveFilingFrequency,
  scoreSupplier,
} from './supplierScore';

// ---------------------------------------------------------------- builders

function match(overrides: Partial<MatchResult> & Pick<MatchResult, 'id'>): MatchResult {
  return {
    status: 'matched',
    tier: 1,
    creditTreatment: 'received',
    bookRowId: 'b1',
    portalRowId: 'p1',
    supplierName: 'Sharma Steel',
    supplierGstin: '27AAPFU0939F1ZV',
    panKey: 'AAPFU0939F',
    invoiceNumber: 'INV/1',
    invoiceNumberNormalized: 'INV1',
    invoiceDate: '2026-01-10',
    docType: 'invoice',
    expectedPeriod: '2026-01',
    actualPeriod: '2026-01',
    delayMonths: 0,
    excessDelayMonths: 0,
    notYetDue: false,
    onTime: true,
    taxHeadMismatch: false,
    booksTaxHead: 'intra',
    portalTaxHead: 'intra',
    taxAtRisk: 0,
    taxReceived: 18000,
    taxNeedsCorrection: 0,
    attribution: 'unattributed',
    inScope: true,
    scopeReason: null,
    invoiceNumberDistance: null,
    ...overrides,
  };
}

function ims(overrides: Partial<ImsLogRow> & Pick<ImsLogRow, 'id'>): ImsLogRow {
  return {
    sourceRow: 1,
    period: '2026-01',
    gstin: '27AAPFU0939F1ZV',
    invoiceNumber: 'INV/1',
    invoiceNumberNormalized: 'INV1',
    invoiceDate: '2026-01-10',
    value: 118000,
    action: 'Accept',
    actionDate: '2026-02-12',
    remark: null,
    recordType: 'invoice',
    ...overrides,
  };
}

function contextWith(rows: ImsLogRow[], periods = ['2026-01']): AttributionContext {
  const index = new Map(rows.map((row) => [`${row.gstin ?? ''}|${row.invoiceNumberNormalized}`, row]));
  return { imsIndex: index, periodsWithImsLog: new Set(periods) };
}

// ------------------------------------------------------------- attribution

describe('attribution', () => {
  it('blames the recipient, not the supplier, when the buyer rejected the invoice', () => {
    // The case the whole attribution layer exists for. The supplier filed correctly;
    // the buyer's own staff rejected the record, so it never reached GSTR-2B.
    const gap = match({ id: 'm1', status: 'missing_in_2b', portalRowId: null, taxAtRisk: 18000 });
    const context = contextWith([ims({ id: 'i1', action: 'Reject' })]);

    const attribution = attributeResult(gap, context);

    expect(attribution).toBe('recipient_rejected');
    expect(isRecipientCause(attribution)).toBe(true);
    expect(isSupplierFault(attribution)).toBe(false);
  });

  it('attributes a held record to the recipient too', () => {
    const gap = match({ id: 'm1', status: 'missing_in_2b', portalRowId: null, taxAtRisk: 18000 });
    expect(attributeResult(gap, contextWith([ims({ id: 'i1', action: 'Pending' })]))).toBe(
      'recipient_kept_pending',
    );
  });

  it('blames the supplier when an IMS log covers the period and holds no action against it', () => {
    const gap = match({ id: 'm1', status: 'missing_in_2b', portalRowId: null, taxAtRisk: 18000 });
    expect(attributeResult(gap, contextWith([]))).toBe('supplier_never_reported');
  });

  it('refuses to attribute anything without an IMS log', () => {
    // IMS is an enhancement, never a dependency: with no log there is no basis to say
    // whose fault a gap is, and guessing would be worse than saying so.
    const gap = match({ id: 'm1', status: 'missing_in_2b', portalRowId: null, taxAtRisk: 18000 });
    const noLog: AttributionContext = { imsIndex: new Map(), periodsWithImsLog: new Set() };
    expect(attributeResult(gap, noLog)).toBe('unattributed');
  });

  it('blames the supplier for a late arrival', () => {
    const late = match({ id: 'm1', onTime: false, actualPeriod: '2026-03', delayMonths: 2 });
    expect(attributeResult(late, contextWith([]))).toBe('supplier_reported_late');
  });

  it('marks an on-time record nobody acted on as deemed accepted', () => {
    const untouched = match({ id: 'm1' });
    expect(attributeResult(untouched, contextWith([]))).toBe('deemed_accepted');
    expect(
      attributeResult(untouched, contextWith([ims({ id: 'i1', action: 'NoAction' })])),
    ).toBe('deemed_accepted');
  });

  it('does not call an actively accepted record deemed accepted', () => {
    const accepted = match({ id: 'm1' });
    expect(attributeResult(accepted, contextWith([ims({ id: 'i1', action: 'Accept' })]))).toBe(
      'unattributed',
    );
  });

  it('attributes nothing to an out-of-scope document', () => {
    const blocked = match({ id: 'm1', inScope: false, scopeReason: 'blocked_17_5' });
    expect(attributeResult(blocked, contextWith([]))).toBe('unattributed');
  });

  it('keeps healthy accepted records out of the attribution split', () => {
    const split = buildAttributionSplit([
      match({ id: 'm1', attribution: 'unattributed' }),
      match({ id: 'm2', status: 'missing_in_2b', attribution: 'recipient_rejected', taxAtRisk: 5000 }),
    ]);

    expect(split.find((e) => e.attribution === 'unattributed')?.count).toBe(0);
    expect(split.find((e) => e.attribution === 'recipient_rejected')?.count).toBe(1);
    expect(split.find((e) => e.attribution === 'recipient_rejected')?.isRecipientCause).toBe(true);
  });
});

describe('suspectsWrongRecipientGstin', () => {
  const never = () => false;

  /** Ten clean documents and three that reached neither 2B nor IMS. */
  const nandiShape = () => [
    ...['2026-01', '2026-02', '2026-03'].flatMap((period, p) =>
      [0, 1, 2].map((n) =>
        match({
          id: `ok-${String(p)}-${String(n)}`,
          expectedPeriod: period,
          actualPeriod: period,
          onTime: true,
        }),
      ),
    ),
    match({ id: 'ok-extra', expectedPeriod: '2026-01', actualPeriod: '2026-01', onTime: true }),
    ...['2026-01', '2026-02', '2026-03'].map((period, i) =>
      match({
        id: `gap-${String(i)}`,
        status: 'missing_in_2b',
        tier: null,
        portalRowId: null,
        taxReceived: 0,
        taxAtRisk: 15_000,
        onTime: null,
        expectedPeriod: period,
        actualPeriod: null,
      }),
    ),
  ];

  it('fires when matched siblings prove on-time filing in the same periods', () => {
    const verdict = suspectsWrongRecipientGstin({
      results: nandiShape(),
      hasImsEntry: never,
    });

    expect(verdict.suspected).toBe(true);
    expect(verdict.documents).toHaveLength(3);
    expect(verdict.confirmedPeriods).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('stays silent when the supplier has no on-time filing to point to', () => {
    // Every document missing. Non-filing explains this perfectly well.
    const allMissing = ['2026-01', '2026-02', '2026-03'].map((period, i) =>
      match({
        id: `gap-${String(i)}`,
        status: 'missing_in_2b',
        portalRowId: null,
        taxReceived: 0,
        taxAtRisk: 15_000,
        onTime: null,
        expectedPeriod: period,
        actualPeriod: null,
      }),
    );

    expect(suspectsWrongRecipientGstin({ results: allMissing, hasImsEntry: never }).suspected).toBe(
      false,
    );
  });

  it('stays silent when the user rejected or held the document', () => {
    // Present in IMS means it reached the buyer, so the recipient GSTIN was right.
    const verdict = suspectsWrongRecipientGstin({
      results: nandiShape(),
      hasImsEntry: () => true,
    });
    expect(verdict.suspected).toBe(false);
  });

  it('stays silent for a gap in a period the supplier never filed for', () => {
    const results = [
      ...['2026-01', '2026-02'].map((period, i) =>
        match({ id: `ok-${String(i)}`, expectedPeriod: period, actualPeriod: period }),
      ),
      match({
        id: 'gap',
        status: 'missing_in_2b',
        portalRowId: null,
        taxReceived: 0,
        taxAtRisk: 15_000,
        onTime: null,
        // No matched sibling in this period, so nothing rules out non-filing.
        expectedPeriod: '2026-09',
        actualPeriod: null,
      }),
    ];

    expect(suspectsWrongRecipientGstin({ results, hasImsEntry: never }).suspected).toBe(false);
  });

  it('ignores documents that are not due yet', () => {
    const results = [
      ...['2026-01', '2026-02'].map((period, i) =>
        match({ id: `ok-${String(i)}`, expectedPeriod: period, actualPeriod: period }),
      ),
      match({
        id: 'gap',
        status: 'missing_in_2b',
        portalRowId: null,
        notYetDue: true,
        taxReceived: 0,
        taxAtRisk: 0,
        onTime: null,
        expectedPeriod: '2026-02',
        actualPeriod: null,
      }),
    ];

    expect(suspectsWrongRecipientGstin({ results, hasImsEntry: never }).suspected).toBe(false);
  });
});

// ----------------------------------------------------------------- scoring

describe('supplier scoring', () => {
  const baseInput = {
    key: '27AAPFU0939F1ZV',
    gstin: '27AAPFU0939F1ZV',
    panKey: 'AAPFU0939F',
    name: 'Sharma Steel',
    master: undefined as SupplierMasterRow | undefined,
    portalRows: [],
    totalInScopeItc: 1_000_000,
    globalRecovery: { resolved: 40, recovered: 20 },
    supplierRecovery: { resolved: 0, recovered: 0 },
    creditNoteIssueValue: 0,
    booksGstinValid: true,
    wrongRecipientGstinSuspected: false,
  };

  it('returns Insufficient history for a supplier with only two periods', () => {
    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-01', '2026-02', '2026-03'],
      results: [
        match({ id: 'm1', expectedPeriod: '2026-01', actualPeriod: '2026-01' }),
        match({ id: 'm2', expectedPeriod: '2026-02', actualPeriod: '2026-02' }),
      ],
    });

    expect(result.periodsWithData).toBe(2);
    expect(result.score).toBeNull();
    expect(result.flag).toBe('insufficient_history');
  });

  it('scores a supplier with three clean periods', () => {
    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-01', '2026-02', '2026-03'],
      results: ['2026-01', '2026-02', '2026-03'].map((period, i) =>
        match({ id: `m${String(i)}`, expectedPeriod: period, actualPeriod: period }),
      ),
    });

    expect(result.periodsWithData).toBe(3);
    expect(result.score).toBe(100);
    expect(result.flag).toBe('green');
  });

  it('does not penalise a quarterly filer for filing within their quarter', () => {
    // Invoices from April and May arriving in the June 2B are on time under QRMP.
    const quarterly = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-04', '2026-05', '2026-06'],
      results: [
        match({ id: 'm1', expectedPeriod: '2026-04', actualPeriod: '2026-06', delayMonths: 2, excessDelayMonths: 0, onTime: true }),
        match({ id: 'm2', expectedPeriod: '2026-05', actualPeriod: '2026-06', delayMonths: 1, excessDelayMonths: 0, onTime: true }),
        match({ id: 'm3', expectedPeriod: '2026-06', actualPeriod: '2026-06', delayMonths: 0, excessDelayMonths: 0, onTime: true }),
      ],
    });

    expect(quarterly.components.avgDelayMonths).toBe(0);
    expect(quarterly.components.matchRate).toBe(1);
    expect(quarterly.flag).toBe('green');
  });

  it('still penalises a monthly filer for the same delay', () => {
    const monthly = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-04', '2026-05', '2026-06'],
      results: [
        match({ id: 'm1', expectedPeriod: '2026-04', actualPeriod: '2026-06', delayMonths: 2, excessDelayMonths: 2, onTime: false }),
        match({ id: 'm2', expectedPeriod: '2026-05', actualPeriod: '2026-06', delayMonths: 1, excessDelayMonths: 1, onTime: false }),
        match({ id: 'm3', expectedPeriod: '2026-06', actualPeriod: '2026-06', delayMonths: 0, excessDelayMonths: 0, onTime: true }),
      ],
    });

    expect(monthly.components.avgDelayMonths).toBeGreaterThan(0);
    expect(monthly.components.matchRate).toBeLessThan(1);
    expect(monthly.score).toBeLessThan(80);
  });

  /*
   * Regression: a supplier whose every document matched at tier 4.
   *
   * Tier 4 carries no value in either taxReceived or taxAtRisk, by design -- the credit
   * is found but not usable, so counting it as either would overstate a headline figure.
   * That left such a supplier with zero value in every period, so every monthly rate was
   * null, periodsWithData collapsed to 0, and a supplier trading in all eight periods was
   * reported as having no history and drew an empty chart.
   */
  describe('a supplier matched entirely at tier 4', () => {
    const periods = ['2026-01', '2026-02', '2026-03', '2026-04'];

    const tierFour = (period: string, index: number) =>
      match({
        id: `t4-${String(index)}`,
        status: 'gstin_state_mismatch',
        tier: 4,
        creditTreatment: 'needs_correction',
        // The distinguishing shape: found in 2B, but under another of the supplier's
        // own registrations, so neither received nor at risk.
        taxReceived: 0,
        taxAtRisk: 0,
        taxNeedsCorrection: 18000,
        onTime: true,
        expectedPeriod: period,
        actualPeriod: period,
      });

    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: periods,
      results: periods.map((period, index) => tierFour(period, index)),
    });

    it('counts every period it traded in', () => {
      expect(result.periodsWithData).toBe(4);
    });

    it('is not flagged Insufficient history', () => {
      expect(result.flag).not.toBe('insufficient_history');
      expect(result.score).not.toBeNull();
    });

    it('draws a populated per-period series rather than an empty chart', () => {
      const drawn = result.monthlyMatchRate.filter((m) => m.matchRate !== null);
      expect(drawn).toHaveLength(4);
      expect(drawn.every((m) => m.matchRate === 1)).toBe(true);
      expect(drawn.every((m) => m.inScopeValue > 0)).toBe(true);
    });

    it('scores well, since the supplier did report on time', () => {
      expect(result.score).toBeGreaterThanOrEqual(95);
      expect(result.flag).toBe('green');
    });

    it('still keeps the value out of ITC at risk, and names it as needing correction', () => {
      expect(result.itcAtRisk).toBe(0);
      expect(result.needsCorrectionValue).toBe(72000);
      expect(result.suggestedAction).toMatch(/different registration of the same PAN/i);
    });
  });

  it('reports volatility as unknown rather than zero when there is nothing to measure', () => {
    // One observation has no spread. Reporting 0.00 would claim a steadiness that a
    // single period cannot evidence.
    const single = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-01', '2026-02', '2026-03'],
      results: [match({ id: 'm1', expectedPeriod: '2026-01', actualPeriod: '2026-01' })],
    });

    expect(single.periodsWithData).toBe(1);
    expect(single.components.volatility).toBeNull();
    expect(single.componentPoints.volatility).toBeNull();

    const many = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-01', '2026-02', '2026-03'],
      results: ['2026-01', '2026-02', '2026-03'].map((period, i) =>
        match({ id: `m${String(i)}`, expectedPeriod: period, actualPeriod: period }),
      ),
    });

    expect(many.components.volatility).toBe(0);
  });

  /*
   * A supplier who filed everything on time, whose credit the user then rejected in IMS.
   *
   * Rejections used to land in ITC at risk and flow through into expected cash loss via
   * a recovery rate -- but a recovery rate models whether a supplier eventually files,
   * and this supplier already did. Recovering the credit is a sequence of user actions,
   * not a probability. And the remarks show most rejections are correct, so the credit
   * was never claimable in the first place.
   */
  describe('a supplier whose credit the user rejected', () => {
    const periods = ['2026-01', '2026-02', '2026-03'];

    const rejected = (period: string, index: number) =>
      match({
        id: `rej-${String(index)}`,
        status: 'missing_in_2b',
        tier: null,
        portalRowId: null,
        creditTreatment: 'at_risk',
        attribution: 'recipient_rejected',
        taxReceived: 0,
        taxAtRisk: 61_108,
        onTime: null,
        expectedPeriod: period,
        actualPeriod: null,
      });

    // Clean matched volume alongside, so the supplier is scoreable.
    const clean = periods.map((period, i) =>
      match({ id: `ok-${String(i)}`, expectedPeriod: period, actualPeriod: period }),
    );

    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: periods,
      results: [...clean, ...periods.map((period, i) => rejected(period, i))],
    });

    it('keeps rejected credit out of ITC at risk', () => {
      expect(result.itcAtRisk).toBe(0);
    });

    it('keeps rejected credit out of expected cash loss', () => {
      expect(result.expectedCashLoss).toBe(0);
    });

    it('reports it in its own bucket instead, at full value', () => {
      expect(result.declinedValue).toBe(183_324);
    });

    it('does not blame the supplier for it', () => {
      expect(result.components.matchRate).toBe(1);
      expect(result.components.disputeRate).toBe(0);
      expect(result.score).toBe(100);
    });

    /*
     * The score is 100 and deserves to be -- but the flag is the only column most
     * readers scan, and OK beside a six-figure gap is misleading.
     */
    it('does not render as OK, because the gap is waiting on the user', () => {
      expect(result.flag).not.toBe('green');
      expect(result.flag).toBe('user_action');
      expect(result.suggestedAction).toMatch(/your decision/i);
    });
  });

  it('leaves a supplier flagged OK when the user-caused gap is immaterial', () => {
    const periods = ['2026-01', '2026-02', '2026-03'];
    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: periods,
      results: [
        ...periods.map((period, i) =>
          match({ id: `ok-${String(i)}`, expectedPeriod: period, actualPeriod: period }),
        ),
        match({
          id: 'small',
          status: 'missing_in_2b',
          portalRowId: null,
          attribution: 'recipient_rejected',
          taxReceived: 0,
          taxAtRisk: 900,
          onTime: null,
          expectedPeriod: '2026-01',
          actualPeriod: null,
        }),
      ],
    });

    expect(result.flag).toBe('green');
  });

  /*
   * A GSTIN that fails its own check digit is not a real registration, so the mismatch
   * is our typing error, not the supplier's filing error. Telling the user to chase a
   * supplier over their own vendor master would waste the call and the goodwill.
   */
  it('tells the user to fix their own master when the books GSTIN fails checksum', () => {
    const periods = ['2026-01', '2026-02', '2026-03'];
    const tierFour = periods.map((period, i) =>
      match({
        id: `t4-${String(i)}`,
        status: 'gstin_state_mismatch',
        tier: 4,
        creditTreatment: 'needs_correction',
        taxReceived: 0,
        taxAtRisk: 0,
        taxNeedsCorrection: 18_000,
        onTime: true,
        expectedPeriod: period,
        actualPeriod: period,
      }),
    );

    const ourError = scoreSupplier({
      ...baseInput,
      booksGstinValid: false,
      scoringPeriods: periods,
      results: tierFour,
    });
    expect(ourError.suggestedAction).toMatch(/your own vendor master/i);
    expect(ourError.suggestedAction).not.toMatch(/ask the supplier/i);

    const theirRegistration = scoreSupplier({
      ...baseInput,
      booksGstinValid: true,
      scoringPeriods: periods,
      results: tierFour,
    });
    expect(theirRegistration.suggestedAction).toMatch(/different registration of the same PAN/i);
  });

  it('raises the wrong-recipient-GSTIN hypothesis in the suggested action', () => {
    const periods = ['2026-01', '2026-02', '2026-03'];
    const result = scoreSupplier({
      ...baseInput,
      wrongRecipientGstinSuspected: true,
      scoringPeriods: periods,
      results: [
        ...periods.map((period, i) =>
          match({ id: `ok-${String(i)}`, expectedPeriod: period, actualPeriod: period }),
        ),
        match({
          id: 'gap',
          status: 'missing_in_2b',
          portalRowId: null,
          attribution: 'supplier_never_reported',
          taxReceived: 0,
          taxAtRisk: 12_000,
          onTime: null,
          expectedPeriod: '2026-02',
          actualPeriod: null,
        }),
      ],
    });

    // Worded as a hypothesis, and pointing at GSTR-1A rather than at filing.
    expect(result.suggestedAction).toMatch(/unlikely to be non-filing/i);
    expect(result.suggestedAction).toMatch(/GSTR-1A/);
    expect(result.suggestedAction).not.toMatch(/ask for their GSTR-1 filing date/i);
  });

  it('excludes blocked credits from ITC at risk', () => {
    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-01', '2026-02', '2026-03'],
      results: [
        match({
          id: 'm1',
          status: 'missing_in_2b',
          portalRowId: null,
          inScope: false,
          scopeReason: 'blocked_17_5',
          creditTreatment: 'not_applicable',
          taxAtRisk: 0,
          taxReceived: 0,
          expectedPeriod: '2026-01',
          actualPeriod: null,
        }),
      ],
    });

    expect(result.itcAtRisk).toBe(0);
    expect(result.expectedCashLoss).toBe(0);
  });

  it('does not let the buyer own rejections drag down the supplier match rate', () => {
    // Every invoice was filed and every one was rejected by the buyer. The supplier
    // did nothing wrong, so the score must not read as though they did.
    const result = scoreSupplier({
      ...baseInput,
      scoringPeriods: ['2026-01', '2026-02', '2026-03'],
      results: ['2026-01', '2026-02', '2026-03'].map((period, i) =>
        match({
          id: `m${String(i)}`,
          status: 'missing_in_2b',
          portalRowId: null,
          attribution: 'recipient_rejected',
          creditTreatment: 'at_risk',
          taxAtRisk: 18000,
          taxReceived: 0,
          expectedPeriod: period,
          actualPeriod: null,
        }),
      ),
    });

    expect(result.components.matchRate).toBe(1);
    expect(result.components.disputeRate).toBe(0);
    /*
     * Not at risk, and not an expected loss. The supplier filed, so there is no filing
     * behaviour for a recovery rate to model, and a rejection is usually correct --
     * goods never received, duplicate already booked. It is reported for review instead.
     */
    expect(result.itcAtRisk).toBe(0);
    expect(result.expectedCashLoss).toBe(0);
    expect(result.declinedValue).toBe(54000);
    expect(result.flag).toBe('user_action');
    expect(result.suggestedAction).toMatch(/your decision, not theirs/i);
  });

  it('labels which recovery rate it used', () => {
    const global = recoveryRateFor({ resolved: 2, recovered: 1 }, { resolved: 50, recovered: 30 });
    expect(global.source).toBe('global');
    expect(global.rate).toBeCloseTo(0.6);

    const supplier = recoveryRateFor({ resolved: 20, recovered: 5 }, { resolved: 50, recovered: 30 });
    expect(supplier.source).toBe('supplier');
    expect(supplier.rate).toBeCloseTo(0.25);
    expect(supplier.sampleSize).toBe(20);
  });

  it('falls back to the configured default when there is no history at all', () => {
    const basis = recoveryRateFor({ resolved: 0, recovered: 0 }, { resolved: 0, recovered: 0 });
    expect(basis.source).toBe('global');
    expect(basis.sampleSize).toBe(0);
  });
});

describe('flagForScore', () => {
  it('applies the configured bands and suppresses short history', () => {
    expect(flagForScore(85, 6)).toBe('green');
    expect(flagForScore(80, 6)).toBe('green');
    expect(flagForScore(79, 6)).toBe('amber');
    expect(flagForScore(50, 6)).toBe('amber');
    expect(flagForScore(49, 6)).toBe('red');
    expect(flagForScore(10, 2)).toBe('insufficient_history');
    expect(flagForScore(null, 6)).toBe('insufficient_history');
  });
});

describe('populationStdDev', () => {
  it('is zero for a constant series and positive for a varying one', () => {
    expect(populationStdDev([0.9, 0.9, 0.9])).toBe(0);
    expect(populationStdDev([1, 0, 1, 0])).toBeCloseTo(0.5);
    expect(populationStdDev([])).toBe(0);
  });
});

describe('filing frequency', () => {
  it('believes the supplier master over any inference', () => {
    const master: SupplierMasterRow = {
      sourceRow: 2,
      supplierName: 'Kaveri Packaging',
      gstin: '29AAGCB7383J1Z4',
      contactPerson: null,
      email: null,
      phone: null,
      paymentTermsDays: null,
      filingFrequency: 'quarterly',
    };

    const resolved = resolveFilingFrequency(master, ['2026-01-11', '2026-02-11', '2026-03-11']);
    expect(resolved.frequency).toBe('quarterly');
    expect(resolved.source).toBe('master');
    expect(resolved.confidence).toBe('high');
  });

  it('infers quarterly from a sparse filing pattern, at low confidence', () => {
    const inferred = inferFilingFrequency(['2026-07-11', '2026-10-11', '2027-01-11']);
    expect(inferred.frequency).toBe('quarterly');
    expect(inferred.source).toBe('inferred');
    expect(inferred.confidence).toBe('low');
  });

  it('infers monthly when filings appear every month', () => {
    const inferred = inferFilingFrequency([
      '2026-05-11',
      '2026-06-11',
      '2026-07-11',
      '2026-08-11',
    ]);
    expect(inferred.frequency).toBe('monthly');
    expect(inferred.confidence).toBe('low');
  });
});

// ---------------------------------------------------------- pending ageing

describe('pending ageing', () => {
  it('buckets by age', () => {
    expect(bucketForAge(0)).toBe('0-30');
    expect(bucketForAge(30)).toBe('0-30');
    expect(bucketForAge(31)).toBe('31-60');
    expect(bucketForAge(60)).toBe('31-60');
    expect(bucketForAge(61)).toBe('61-90');
    expect(bucketForAge(90)).toBe('61-90');
    expect(bucketForAge(91)).toBe('90+');
  });

  it('flags the run-up to the section 16(4) deadline', () => {
    expect(deadlineFlagFor(200)).toBe('ok');
    expect(deadlineFlagFor(120)).toBe('amber');
    expect(deadlineFlagFor(61)).toBe('amber');
    expect(deadlineFlagFor(60)).toBe('red');
    expect(deadlineFlagFor(0)).toBe('red');
    expect(deadlineFlagFor(-1)).toBe('expired');
  });

  it('places a pending record either side of the 30 November boundary', () => {
    // An FY 2025-26 invoice expires on 30 November 2026. One day before it is still
    // claimable; one day after, the credit is simply gone.
    const rows = [
      ims({ id: 'i1', action: 'Pending', invoiceDate: '2026-01-10', actionDate: '2026-02-10' }),
    ];

    const dayBefore = buildPendingAgeing({ imsRows: rows, results: [], asOf: '2026-11-29' });
    expect(dayBefore.rows[0]?.section16_4Deadline).toBe('2026-11-30');
    expect(dayBefore.rows[0]?.daysToDeadline).toBe(1);
    expect(dayBefore.rows[0]?.deadlineFlag).toBe('red');

    const onTheDay = buildPendingAgeing({ imsRows: rows, results: [], asOf: '2026-11-30' });
    expect(onTheDay.rows[0]?.daysToDeadline).toBe(0);
    expect(onTheDay.rows[0]?.deadlineFlag).toBe('red');

    const dayAfter = buildPendingAgeing({ imsRows: rows, results: [], asOf: '2026-12-01' });
    expect(dayAfter.rows[0]?.daysToDeadline).toBe(-1);
    expect(dayAfter.rows[0]?.deadlineFlag).toBe('expired');
  });

  it('ignores records that are not pending', () => {
    const report = buildPendingAgeing({
      imsRows: [ims({ id: 'i1', action: 'Accept' }), ims({ id: 'i2', action: 'Reject' })],
      results: [],
      asOf: '2026-06-01',
    });
    expect(report.rows).toHaveLength(0);
  });

  it('takes the tax value from the matched document, not the IMS total', () => {
    const report = buildPendingAgeing({
      imsRows: [ims({ id: 'i1', action: 'Pending' })],
      results: [match({ id: 'm1', taxReceived: 0, taxAtRisk: 18000, status: 'missing_in_2b' })],
      asOf: '2026-06-01',
    });

    expect(report.rows[0]?.taxValue).toBe(18000);
    expect(report.totalTaxValue).toBe(18000);
  });

  it('sorts the most urgent first', () => {
    const report = buildPendingAgeing({
      imsRows: [
        ims({ id: 'later', action: 'Pending', invoiceDate: '2026-06-10', invoiceNumberNormalized: 'A' }),
        ims({ id: 'sooner', action: 'Pending', invoiceDate: '2025-06-10', invoiceNumberNormalized: 'B' }),
      ],
      results: [],
      asOf: '2026-08-01',
    });

    expect(report.rows[0]?.imsRowId).toBe('sooner');
  });
});
