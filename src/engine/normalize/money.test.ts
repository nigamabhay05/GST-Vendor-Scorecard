import { describe, expect, it } from 'vitest';
import {
  amountsEqual,
  emptyTax,
  isTaxHeadMismatch,
  parseMoney,
  parseMoneyOrZero,
  roundRupees,
  taxHeadOf,
  totalTax,
} from './money';

describe('parseMoney', () => {
  it('parses a rupee amount written the way a portal export writes it', () => {
    const result = parseMoney('₹1,44,000.00');
    expect(result.value).toBe(144000);
    expect(result.problem).toBeNull();
  });

  it('reads parentheses as negative, the way an accountant writes them', () => {
    expect(parseMoney('(1,200)').value).toBe(-1200);
    expect(parseMoney('(₹1,200.50)').value).toBe(-1200.5);
  });

  it('accepts a number that arrived as a number', () => {
    expect(parseMoney(144000).value).toBe(144000);
    expect(parseMoney(0).value).toBe(0);
    expect(parseMoney(-1200.5).value).toBe(-1200.5);
  });

  it('reports blank cells as blank, not as zero', () => {
    // The distinction matters: a blank IGST column means "not an inter-state supply",
    // while a genuinely unparseable one means the file needs looking at.
    for (const blank of ['', '   ', '-', 'NIL', 'n/a', null, undefined]) {
      const result = parseMoney(blank);
      expect(result.value).toBeNull();
      expect(result.problem).toBe('blank');
    }
  });

  it('reports text that is not an amount as unparseable', () => {
    for (const text of ['see annexure', 'abc', '12,3x4', '--12']) {
      expect(parseMoney(text).problem).toBe('unparseable');
    }
  });

  it('handles amounts stored as text with separators and stray spaces', () => {
    expect(parseMoney('  1,44,000  ').value).toBe(144000);
    expect(parseMoney('1 44 000.75').value).toBe(144000.75);
    // Non-breaking and narrow no-break spaces, which spreadsheets insert silently.
    expect(parseMoney('1,44,000').value).toBe(144000);
    expect(parseMoney('1 44 000').value).toBe(144000);
  });

  it('handles a leading or trailing minus sign', () => {
    expect(parseMoney('-1,200').value).toBe(-1200);
    expect(parseMoney('1,200-').value).toBe(-1200);
    expect(parseMoney('+1,200').value).toBe(1200);
  });

  it('strips Dr and Cr suffixes without inventing a sign from them', () => {
    // Direction comes from the document type, never from a ledger suffix. See
    // ASSUMPTIONS.md -- guessing here would silently flip credit notes.
    expect(parseMoney('1,200 Dr').value).toBe(1200);
    expect(parseMoney('1,200 Cr').value).toBe(1200);
  });

  it('rejects infinities and booleans', () => {
    expect(parseMoney(Number.POSITIVE_INFINITY).problem).toBe('unparseable');
    expect(parseMoney(Number.NaN).problem).toBe('unparseable');
    expect(parseMoney(true).problem).toBe('unparseable');
  });

  it('rounds to paise without floating point drift', () => {
    expect(parseMoney('0.1').value).toBe(0.1);
    expect(roundRupees(1.005 * 100)).toBe(100.5);
  });
});

describe('parseMoneyOrZero', () => {
  it('treats an unusable cell as zero for tax head columns', () => {
    expect(parseMoneyOrZero('')).toBe(0);
    expect(parseMoneyOrZero('rubbish')).toBe(0);
    expect(parseMoneyOrZero('₹9,000')).toBe(9000);
  });
});

describe('amountsEqual', () => {
  it('absorbs rounding differences up to one rupee', () => {
    expect(amountsEqual(144000, 144000.5)).toBe(true);
    expect(amountsEqual(144000, 144001)).toBe(true);
    expect(amountsEqual(144000, 143999)).toBe(true);
  });

  it('does not absorb a real difference', () => {
    expect(amountsEqual(144000, 144001.01)).toBe(false);
    expect(amountsEqual(144000, 140000)).toBe(false);
  });
});

describe('totalTax', () => {
  it('adds every head including cess', () => {
    expect(
      totalTax({ taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 500 }),
    ).toBe(18500);
  });

  it('is zero for an empty tax block', () => {
    expect(totalTax(emptyTax())).toBe(0);
  });
});

describe('taxHeadOf', () => {
  it('identifies intra-state, inter-state, none and mixed', () => {
    expect(taxHeadOf({ taxable: 1, cgst: 9, sgst: 9, igst: 0, cess: 0 })).toBe('intra');
    expect(taxHeadOf({ taxable: 1, cgst: 0, sgst: 0, igst: 18, cess: 0 })).toBe('inter');
    expect(taxHeadOf({ taxable: 1, cgst: 0, sgst: 0, igst: 0, cess: 0 })).toBe('none');
    expect(taxHeadOf({ taxable: 1, cgst: 9, sgst: 9, igst: 18, cess: 0 })).toBe('mixed');
  });
});

describe('isTaxHeadMismatch', () => {
  it('flags books-intra against portal-inter and the reverse', () => {
    expect(isTaxHeadMismatch('intra', 'inter')).toBe(true);
    expect(isTaxHeadMismatch('inter', 'intra')).toBe(true);
  });

  it('does not flag agreement', () => {
    expect(isTaxHeadMismatch('intra', 'intra')).toBe(false);
    expect(isTaxHeadMismatch('inter', 'inter')).toBe(false);
  });

  it('stays silent when either side is indefinite', () => {
    // A zero-rated or nil-tax document says nothing about which head applies, and a
    // mixed document is its own problem -- neither is evidence of a head mismatch.
    expect(isTaxHeadMismatch('none', 'inter')).toBe(false);
    expect(isTaxHeadMismatch('intra', 'none')).toBe(false);
    expect(isTaxHeadMismatch('mixed', 'intra')).toBe(false);
  });
});
