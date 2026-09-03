import { describe, expect, it } from 'vitest';
import type { BookRow, FilingFrequency, Portal2bRow } from '../types';
import { runMatchPipeline } from './pipeline';
import {
  matchesTier1,
  matchesTier2,
  matchesTier3,
  matchesTier4,
  matchesTier5,
} from './tiers';

const MONTHLY = (): FilingFrequency => 'monthly';

function book(overrides: Partial<BookRow> & Pick<BookRow, 'id'>): BookRow {
  return {
    sourceRow: 1,
    period: '2026-04',
    supplierName: 'Sharma Steel',
    supplierGstin: '27AAPFU0939F1ZV',
    panKey: 'AAPFU0939F',
    invoiceNumber: 'INV/2026/001',
    invoiceNumberNormalized: 'INV20261',
    invoiceDate: '2026-04-05',
    docType: 'invoice',
    tax: { taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 },
    itcEligibleFlag: null,
    scope: { inScope: true, reason: null },
    ...overrides,
  };
}

function portal(overrides: Partial<Portal2bRow> & Pick<Portal2bRow, 'id'>): Portal2bRow {
  return {
    sourceRow: 1,
    sourceSection: 'b2b',
    period: '2026-04',
    supplierName: 'Sharma Steel',
    supplierGstin: '27AAPFU0939F1ZV',
    panKey: 'AAPFU0939F',
    invoiceNumber: 'INV-2026-1',
    invoiceNumberNormalized: 'INV20261',
    invoiceDate: '2026-04-05',
    docType: 'invoice',
    tax: { taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 },
    gstr1FilingDate: '2026-05-10',
    itcAvailable: true,
    itcUnavailableReason: null,
    isAmendment: false,
    amendsInvoiceNumberNormalized: null,
    supersededById: null,
    reverseCharge: false,
    ...overrides,
  };
}

describe('tier predicates in isolation', () => {
  it('tier 1 fires on GSTIN, number and value', () => {
    expect(matchesTier1(book({ id: 'b' }), portal({ id: 'p' }))).toBe(true);
  });

  it('tier 1 absorbs a rounding difference but not a real one', () => {
    const nearly = portal({ id: 'p', tax: { taxable: 100000, cgst: 9000, sgst: 9000.5, igst: 0, cess: 0 } });
    expect(matchesTier1(book({ id: 'b' }), nearly)).toBe(true);

    const different = portal({ id: 'p', tax: { taxable: 100000, cgst: 9000, sgst: 8000, igst: 0, cess: 0 } });
    expect(matchesTier1(book({ id: 'b' }), different)).toBe(false);
  });

  it('tier 2 fires when the number agrees and the value does not', () => {
    const short = portal({ id: 'p', tax: { taxable: 90000, cgst: 8100, sgst: 8100, igst: 0, cess: 0 } });
    expect(matchesTier2(book({ id: 'b' }), short)).toBe(true);
    expect(matchesTier1(book({ id: 'b' }), short)).toBe(false);
  });

  it('tier 3 fires on taxable value and a nearby date when numbers differ', () => {
    const renumbered = portal({
      id: 'p',
      invoiceNumber: 'SS/APR/44',
      invoiceNumberNormalized: 'SSAPR44',
      invoiceDate: '2026-04-07',
    });
    expect(matchesTier3(book({ id: 'b' }), renumbered)).toBe(true);
  });

  it('tier 3 does not reach beyond the date tolerance', () => {
    const tooFar = portal({
      id: 'p',
      invoiceNumber: 'SS/APR/44',
      invoiceNumberNormalized: 'SSAPR44',
      invoiceDate: '2026-04-20',
    });
    expect(matchesTier3(book({ id: 'b' }), tooFar)).toBe(false);
  });

  it('tier 4 fires on a different GSTIN with the same PAN', () => {
    // Same business, reported under its other state registration.
    const otherState = portal({ id: 'p', supplierGstin: '29AAPFU0939F1ZP' });
    expect(matchesTier4(book({ id: 'b' }), otherState)).toBe(true);
    expect(matchesTier1(book({ id: 'b' }), otherState)).toBe(false);
  });

  it('tier 5 fires within two edits and not beyond', () => {
    const typo = portal({ id: 'p', invoiceNumberNormalized: 'INV20262' });
    expect(matchesTier5(book({ id: 'b' }), typo)).toBe(true);

    const unrelated = portal({ id: 'p', invoiceNumberNormalized: 'ZZZ99999' });
    expect(matchesTier5(book({ id: 'b' }), unrelated)).toBe(false);
  });

  it('never matches an invoice to a credit note', () => {
    const creditNote = portal({ id: 'p', docType: 'credit_note' });
    expect(matchesTier1(book({ id: 'b' }), creditNote)).toBe(false);
    expect(matchesTier3(book({ id: 'b' }), creditNote)).toBe(false);
    expect(matchesTier5(book({ id: 'b' }), creditNote)).toBe(false);
  });
});

describe('runMatchPipeline', () => {
  it('matches a straightforward invoice at tier 1 and counts the credit as received', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' })],
      portalRows: [portal({ id: 'p1' })],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('matched');
    expect(results[0]?.tier).toBe(1);
    expect(results[0]?.creditTreatment).toBe('received');
    expect(results[0]?.taxReceived).toBe(18000);
    expect(results[0]?.taxAtRisk).toBe(0);
    expect(results[0]?.onTime).toBe(true);
  });

  it('puts only the shortfall at risk on a value mismatch', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' })],
      portalRows: [
        portal({ id: 'p1', tax: { taxable: 90000, cgst: 8100, sgst: 8100, igst: 0, cess: 0 } }),
      ],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.status).toBe('value_mismatch');
    expect(results[0]?.creditTreatment).toBe('partial');
    expect(results[0]?.taxReceived).toBe(16200);
    expect(results[0]?.taxAtRisk).toBe(1800);
  });

  it('counts a tier 4 result as neither received nor at risk', () => {
    // The credit exists but under the wrong registration: overstating it either way
    // would mislead. It is reported as needing correction instead.
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' })],
      portalRows: [portal({ id: 'p1', supplierGstin: '29AAPFU0939F1ZP' })],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.tier).toBe(4);
    expect(results[0]?.creditTreatment).toBe('needs_correction');
    expect(results[0]?.taxAtRisk).toBe(0);
    expect(results[0]?.taxReceived).toBe(0);
  });

  it('enforces one-to-one: one 2B row cannot satisfy two book rows', () => {
    // Without this, the report would claim credit that does not exist.
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' }), book({ id: 'b2' })],
      portalRows: [portal({ id: 'p1' })],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results.filter((r) => r.status === 'matched')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'missing_in_2b')).toHaveLength(1);

    const consumed = results.map((r) => r.portalRowId).filter((id) => id !== null);
    expect(consumed).toEqual(['p1']);
  });

  it('prefers a certain tier 1 match over a speculative tier 5 one elsewhere', () => {
    // b1 could match p2 at tier 5, but p2 is b2's exact tier-1 counterpart. Running
    // every tier across the whole dataset before the next protects the certain match.
    const b1 = book({ id: 'b1', invoiceNumberNormalized: 'INV20261' });
    const b2 = book({ id: 'b2', invoiceNumberNormalized: 'INV20262' });
    const p2 = portal({ id: 'p2', invoiceNumberNormalized: 'INV20262' });

    const results = runMatchPipeline({
      bookRows: [b1, b2],
      portalRows: [p2],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    const matched = results.find((r) => r.status === 'matched');
    expect(matched?.bookRowId).toBe('b2');
    expect(results.find((r) => r.bookRowId === 'b1')?.status).toBe('missing_in_2b');
  });

  it('reports an unmatched book row as missing in GSTR-2B with the full tax at risk', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' })],
      portalRows: [],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.status).toBe('missing_in_2b');
    expect(results[0]?.taxAtRisk).toBe(18000);
    expect(results[0]?.creditTreatment).toBe('at_risk');
  });

  it('reports an unmatched 2B row as missing in books and puts nothing at risk', () => {
    const results = runMatchPipeline({
      bookRows: [],
      portalRows: [portal({ id: 'p1' })],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.status).toBe('missing_in_books');
    expect(results[0]?.taxAtRisk).toBe(0);
  });

  it('excludes an out-of-scope document from at-risk while still reporting it', () => {
    const blocked = book({
      id: 'b1',
      scope: { inScope: false, reason: 'blocked_17_5' },
    });

    const results = runMatchPipeline({
      bookRows: [blocked],
      portalRows: [],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.status).toBe('missing_in_2b');
    expect(results[0]?.taxAtRisk).toBe(0);
    expect(results[0]?.inScope).toBe(false);
    expect(results[0]?.scopeReason).toBe('blocked_17_5');
  });

  it('ignores a superseded 2B row so an amendment is not double-counted', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' })],
      portalRows: [
        portal({ id: 'p_old', supersededById: 'p_new' }),
        portal({ id: 'p_new', period: '2026-05', isAmendment: true, sourceSection: 'b2ba' }),
      ],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.portalRowId).toBe('p_new');
  });

  it('flags a tax head mismatch without calling it a gap', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1' })],
      portalRows: [
        portal({ id: 'p1', tax: { taxable: 100000, cgst: 0, sgst: 0, igst: 18000, cess: 0 } }),
      ],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.status).toBe('matched');
    expect(results[0]?.taxHeadMismatch).toBe(true);
    expect(results[0]?.booksTaxHead).toBe('intra');
    expect(results[0]?.portalTaxHead).toBe('inter');
    expect(results[0]?.taxAtRisk).toBe(0);
  });

  it('measures delay and marks a late arrival as not on time', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1', invoiceDate: '2026-04-05' })],
      portalRows: [portal({ id: 'p1', period: '2026-06' })],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results[0]?.expectedPeriod).toBe('2026-04');
    expect(results[0]?.actualPeriod).toBe('2026-06');
    expect(results[0]?.delayMonths).toBe(2);
    expect(results[0]?.onTime).toBe(false);
  });

  it('does not mark a quarterly filer late inside their own quarter', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1', invoiceDate: '2026-04-05' })],
      portalRows: [portal({ id: 'p1', period: '2026-06' })],
      filingFrequencyOf: () => 'quarterly',
      lastLoadedPeriod: null,
    });

    expect(results[0]?.delayMonths).toBe(2);
    expect(results[0]?.onTime).toBe(true);
  });

  it('leaves credit notes out of invoice matching entirely', () => {
    const results = runMatchPipeline({
      bookRows: [book({ id: 'b1', docType: 'credit_note' })],
      portalRows: [portal({ id: 'p1', docType: 'credit_note' })],
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(results).toHaveLength(0);
  });

  it('produces identical output for the same input, whatever order it arrives in', () => {
    // Reproducibility is what makes the output usable as evidence.
    const books = [book({ id: 'b1' }), book({ id: 'b2', invoiceNumberNormalized: 'INV20262' })];
    const portals = [
      portal({ id: 'p1' }),
      portal({ id: 'p2', invoiceNumberNormalized: 'INV20262' }),
    ];

    const forward = runMatchPipeline({
      bookRows: books,
      portalRows: portals,
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });
    const reversed = runMatchPipeline({
      bookRows: [...books].reverse(),
      portalRows: [...portals].reverse(),
      filingFrequencyOf: MONTHLY,
      lastLoadedPeriod: null,
    });

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
