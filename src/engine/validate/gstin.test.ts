import { describe, expect, it } from 'vitest';
import {
  computeGstinCheckCharacter,
  isGstinFullyValid,
  normalizeGstin,
  panKeyOf,
  validateGstin,
} from './gstin';

/*
 * `27AAPFU0939F1ZV` is the GSTIN used as the worked example in GSTN's own
 * documentation; the other three are structurally valid GSTINs whose check character
 * this implementation reproduces independently. Four independent agreements is the
 * evidence that the checksum below is the real algorithm and not merely self-consistent.
 */
const KNOWN_VALID = [
  '27AAPFU0939F1ZV',
  '29AAGCB7383J1Z4',
  '09AAACH7409R1ZZ',
  '24AAACC1206D1ZM',
] as const;

describe('computeGstinCheckCharacter', () => {
  it('reproduces the check character of known-valid GSTINs', () => {
    for (const gstin of KNOWN_VALID) {
      expect(computeGstinCheckCharacter(gstin.slice(0, 14))).toBe(gstin[14]);
    }
  });

  it('returns null unless given exactly fourteen characters', () => {
    expect(computeGstinCheckCharacter('27AAPFU0939F1')).toBeNull();
    expect(computeGstinCheckCharacter('27AAPFU0939F1ZV')).toBeNull();
    expect(computeGstinCheckCharacter('')).toBeNull();
  });

  it('returns null when a character is outside the base-36 alphabet', () => {
    expect(computeGstinCheckCharacter('27AAPFU0939F1$')).toBeNull();
  });
});

describe('validateGstin', () => {
  it('accepts a valid GSTIN', () => {
    const result = validateGstin('27AAPFU0939F1ZV');
    expect(result.formatValid).toBe(true);
    expect(result.checkDigitValid).toBe(true);
    expect(result.stateCode).toBe('27');
    expect(result.panKey).toBe('AAPFU0939F');
    expect(result.blank).toBe(false);
  });

  it('accepts lowercase input by normalising it first', () => {
    const result = validateGstin('27aapfu0939f1zv');
    expect(result.normalized).toBe('27AAPFU0939F1ZV');
    expect(result.formatValid).toBe(true);
    expect(result.checkDigitValid).toBe(true);
  });

  it('tolerates surrounding whitespace and internal spacing', () => {
    expect(validateGstin('  27 AAPFU 0939 F1ZV ').checkDigitValid).toBe(true);
  });

  it('reports a wrong check digit without rejecting the GSTIN outright', () => {
    // Same GSTIN, last character changed from V to W.
    const result = validateGstin('27AAPFU0939F1ZW');

    expect(result.formatValid).toBe(true);
    expect(result.checkDigitValid).toBe(false);
    expect(result.expectedCheckCharacter).toBe('V');

    // The point of the design: the value survives so downstream matching can still use
    // it, rather than a supplier's data vanishing because of one bad character.
    expect(result.normalized).toBe('27AAPFU0939F1ZW');
    expect(result.panKey).toBe('AAPFU0939F');
  });

  it('reports a wrong length as a format failure, not a checksum failure', () => {
    const short = validateGstin('27AAPFU0939F1Z');
    expect(short.formatValid).toBe(false);
    expect(short.checkDigitValid).toBeNull();

    const long = validateGstin('27AAPFU0939F1ZVX');
    expect(long.formatValid).toBe(false);
    expect(long.checkDigitValid).toBeNull();
  });

  it('reports a blank cell as blank rather than malformed', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const result = validateGstin(blank);
      expect(result.blank).toBe(true);
      expect(result.normalized).toBeNull();
      expect(result.formatValid).toBe(false);
    }
  });

  it('still extracts the PAN from a structurally wrong GSTIN', () => {
    // The 14th character must be Z; here it is X. Tier 4 matching still needs the PAN.
    const result = validateGstin('27AAPFU0939F1XV');
    expect(result.formatValid).toBe(false);
    expect(result.panKey).toBe('AAPFU0939F');
    expect(result.stateCode).toBe('27');
  });
});

describe('normalizeGstin', () => {
  it('returns null for blank input and uppercases everything else', () => {
    expect(normalizeGstin('   ')).toBeNull();
    expect(normalizeGstin(null)).toBeNull();
    expect(normalizeGstin('27aapfu0939f1zv')).toBe('27AAPFU0939F1ZV');
  });
});

describe('panKeyOf', () => {
  it('takes characters 3 to 12', () => {
    expect(panKeyOf('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
  });

  it('returns null when there are not enough characters', () => {
    expect(panKeyOf('27AAPFU')).toBeNull();
    expect(panKeyOf(null)).toBeNull();
  });

  it('gives the same PAN for one supplier registered in two states', () => {
    // The case match tier 4 exists for: same business, different state registration.
    expect(panKeyOf('27AAPFU0939F1ZV')).toBe(panKeyOf('29AAPFU0939F1ZP'));
  });
});

describe('isGstinFullyValid', () => {
  it('requires both format and check digit', () => {
    expect(isGstinFullyValid('27AAPFU0939F1ZV')).toBe(true);
    expect(isGstinFullyValid('27AAPFU0939F1ZW')).toBe(false);
    expect(isGstinFullyValid('nonsense')).toBe(false);
  });
});
