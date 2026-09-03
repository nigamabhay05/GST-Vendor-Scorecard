import { describe, expect, it } from 'vitest';
import type { ImsLogRow, MatchResult, SupplierMasterRow } from '../types';
import {
  attributeResult,
  buildAttributionSplit,
  isRecipientCause,
  isSupplierFault,
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
    // The money is still reported as at risk: the buyer really has lost this credit.
    expect(result.itcAtRisk).toBe(54000);
    expect(result.suggestedAction).toMatch(/your own IMS decisions/i);
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
