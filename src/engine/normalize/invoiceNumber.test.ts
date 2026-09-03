import { describe, expect, it } from 'vitest';
import {
  findNormalizationCollisions,
  isWithinEditDistance,
  levenshtein,
  normalizeInvoiceNumber,
} from './invoiceNumber';

describe('normalizeInvoiceNumber', () => {
  it('collapses the same invoice written two ways', () => {
    // The case the whole rule exists for: books say one, the portal says the other.
    expect(normalizeInvoiceNumber('INV/2026/001')).toBe('INV20261');
    expect(normalizeInvoiceNumber('INV-2026-1')).toBe('INV20261');
    expect(normalizeInvoiceNumber('INV/2026/001')).toBe(normalizeInvoiceNumber('INV-2026-1'));
  });

  it('uppercases', () => {
    expect(normalizeInvoiceNumber('inv/2026/001')).toBe('INV20261');
  });

  it('strips leading zeros from every numeric run independently', () => {
    expect(normalizeInvoiceNumber('GST/007/0042')).toBe('GST742');
    expect(normalizeInvoiceNumber('A0001B0002')).toBe('A1B2');
  });

  it('never reduces an all-zero run to nothing', () => {
    // "000" and "0" are the same invoice; "" would silently match everything.
    expect(normalizeInvoiceNumber('INV/000')).toBe('INV0');
    expect(normalizeInvoiceNumber('0')).toBe('0');
  });

  it('discards separators, spaces and punctuation', () => {
    expect(normalizeInvoiceNumber('INV # 2026 / 001')).toBe('INV20261');
    expect(normalizeInvoiceNumber('INV\\2026\\001')).toBe('INV20261');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeInvoiceNumber('')).toBe('');
    expect(normalizeInvoiceNumber(null)).toBe('');
    expect(normalizeInvoiceNumber(undefined)).toBe('');
    expect(normalizeInvoiceNumber('///')).toBe('');
  });

  it('accepts a number that arrived as a number', () => {
    expect(normalizeInvoiceNumber(1001)).toBe('1001');
  });
});

describe('levenshtein', () => {
  it('measures ordinary edits', () => {
    expect(levenshtein('INV20261', 'INV20261')).toBe(0);
    expect(levenshtein('INV20261', 'INV20262')).toBe(1);
    expect(levenshtein('INV20261', 'INV2061')).toBe(1);
    expect(levenshtein('', 'ABC')).toBe(3);
    expect(levenshtein('ABC', '')).toBe(3);
  });

  it('counts a transposition as two edits', () => {
    // Plain Levenshtein, not Damerau -- so tier 5's allowance of 2 covers exactly one
    // transposed pair, which is the commonest typing slip in an invoice number.
    expect(levenshtein('INV12', 'INV21')).toBe(2);
  });

  it('stops early once the distance cannot matter', () => {
    // The bounded form must never report a distance at or below max when the true
    // distance is above it.
    expect(levenshtein('AAAAAAAA', 'BBBBBBBB', 2)).toBeGreaterThan(2);
    expect(levenshtein('SHORT', 'A_MUCH_LONGER_STRING', 2)).toBeGreaterThan(2);
    expect(levenshtein('INV20261', 'INV20262', 2)).toBe(1);
  });
});

describe('isWithinEditDistance', () => {
  it('accepts one and two edits but not three', () => {
    expect(isWithinEditDistance('INV20261', 'INV20262', 2)).toBe(true);
    expect(isWithinEditDistance('INV12', 'INV21', 2)).toBe(true);
    expect(isWithinEditDistance('INV20261', 'XYZ99999', 2)).toBe(false);
  });
});

describe('findNormalizationCollisions', () => {
  interface Row {
    id: string;
    original: string;
  }
  const keyOf = (r: Row) => normalizeInvoiceNumber(r.original);
  const originalOf = (r: Row) => r.original;

  it('flags two genuinely different invoices that normalise to one key', () => {
    // This is the guard the aggressive normalisation rule needs. A/1 and A-01 are two
    // separate documents; merging them would halve the recorded purchase value.
    const rows: Row[] = [
      { id: 'r1', original: 'A/1' },
      { id: 'r2', original: 'A-01' },
    ];

    const collisions = findNormalizationCollisions(rows, keyOf, originalOf);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.normalizedKey).toBe('A1');
    expect(collisions[0]?.members.map((m) => m.id)).toEqual(['r1', 'r2']);
  });

  it('does not treat a repeated invoice number as a collision', () => {
    // The same number twice is a duplicate, which is a different finding with a
    // different remedy. Reporting it here would bury the real collisions in noise.
    const rows: Row[] = [
      { id: 'r1', original: 'INV/2026/001' },
      { id: 'r2', original: 'INV/2026/001' },
    ];

    expect(findNormalizationCollisions(rows, keyOf, originalOf)).toHaveLength(0);
  });

  it('ignores case and surrounding space when deciding what counts as distinct', () => {
    const rows: Row[] = [
      { id: 'r1', original: 'inv/2026/001' },
      { id: 'r2', original: ' INV/2026/001 ' },
    ];

    expect(findNormalizationCollisions(rows, keyOf, originalOf)).toHaveLength(0);
  });

  it('ignores rows that normalise to nothing', () => {
    const rows: Row[] = [
      { id: 'r1', original: '///' },
      { id: 'r2', original: '---' },
    ];

    expect(findNormalizationCollisions(rows, keyOf, originalOf)).toHaveLength(0);
  });

  it('returns collisions in a deterministic order', () => {
    const rows: Row[] = [
      { id: 'r1', original: 'Z/1' },
      { id: 'r2', original: 'Z-01' },
      { id: 'r3', original: 'A/9' },
      { id: 'r4', original: 'A-009' },
    ];

    const keys = findNormalizationCollisions(rows, keyOf, originalOf).map(
      (c) => c.normalizedKey,
    );
    expect(keys).toEqual(['A9', 'Z1']);
  });
});
