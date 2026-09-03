import type { Gstin, PanKey } from '../types';
import { asText } from '../normalize/text';

/**
 * GSTIN format and check-digit validation.
 *
 * A GSTIN is 15 characters: a two-digit state code, a ten-character PAN, an entity
 * number, the literal `Z`, and a check character computed from the other fourteen.
 *
 * The important design decision here is what happens on failure. A failed check digit
 * is reported as a *warning* and processing continues with the GSTIN as given. If it
 * were a hard rejection, a bug in the checksum below -- or an unusual but genuine GSTIN
 * -- would silently delete a supplier's entire history from the analysis, and the user
 * would have no way to tell. A warning they can see beats a deletion they cannot.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Two digits, five letters, four digits, a letter, an entity character, `Z`, check. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface GstinValidation {
  raw: string;
  /** Uppercased and stripped of whitespace. Null when the cell was blank. */
  normalized: Gstin | null;
  blank: boolean;
  formatValid: boolean;
  /** Null when the format is wrong, since the checksum then means nothing. */
  checkDigitValid: boolean | null;
  expectedCheckCharacter: string | null;
  stateCode: string | null;
  /** Characters 3-12: the supplier's PAN. Match tier 4 keys on this. */
  panKey: PanKey | null;
}

/**
 * The check character for a GSTIN's first fourteen characters.
 *
 * Each character contributes its position in `ALPHABET`, doubled on odd positions. The
 * doubling can push a product past 36, so the two base-36 digits of the product are
 * summed rather than the product itself -- the same trick as the Luhn algorithm.
 */
export function computeGstinCheckCharacter(first14: string): string | null {
  if (first14.length !== 14) return null;

  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const char = first14[i];
    if (char === undefined) return null;

    const code = ALPHABET.indexOf(char);
    if (code < 0) return null;

    const factor = i % 2 === 0 ? 1 : 2;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }

  return ALPHABET[(36 - (sum % 36)) % 36] ?? null;
}

/** Uppercases and strips whitespace and common separators. Null when blank. */
export function normalizeGstin(raw: unknown): Gstin | null {
  if (raw === null || raw === undefined) return null;

  // The regex class below already covers the non-breaking and thin spaces that
  // spreadsheets insert inside a GSTIN, since JavaScript's \s includes U+00A0, U+2009
  // and U+202F. Hyphens go too, because some exports group the characters.
  const cleaned = asText(raw)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .trim();

  return cleaned === '' ? null : cleaned;
}

/** Characters 3-12 of a GSTIN. Null unless the GSTIN is at least 12 characters. */
export function panKeyOf(gstin: Gstin | null | undefined): PanKey | null {
  if (!gstin || gstin.length < 12) return null;
  return gstin.slice(2, 12);
}

export function isGstinFormatValid(value: string): boolean {
  return GSTIN_PATTERN.test(value);
}

export function validateGstin(raw: unknown): GstinValidation {
  const rawText = asText(raw);
  const normalized = normalizeGstin(raw);

  if (normalized === null) {
    return {
      raw: rawText,
      normalized: null,
      blank: true,
      formatValid: false,
      checkDigitValid: null,
      expectedCheckCharacter: null,
      stateCode: null,
      panKey: null,
    };
  }

  const formatValid = isGstinFormatValid(normalized);

  // The state code and PAN are read positionally even from a malformed GSTIN: a
  // transposed digit somewhere else should not stop tier 4 from matching on the PAN.
  const stateCode = normalized.length >= 2 ? normalized.slice(0, 2) : null;
  const panKey = panKeyOf(normalized);

  if (!formatValid) {
    return {
      raw: rawText,
      normalized,
      blank: false,
      formatValid: false,
      checkDigitValid: null,
      expectedCheckCharacter: null,
      stateCode,
      panKey,
    };
  }

  const expected = computeGstinCheckCharacter(normalized.slice(0, 14));

  return {
    raw: rawText,
    normalized,
    blank: false,
    formatValid: true,
    checkDigitValid: expected === null ? null : expected === normalized[14],
    expectedCheckCharacter: expected,
    stateCode,
    panKey,
  };
}

/**
 * Convenience predicate for the fully valid case. Deliberately *not* used as a filter
 * anywhere in the pipeline -- see the note at the top of this file about warnings
 * versus deletions.
 */
export function isGstinFullyValid(raw: unknown): boolean {
  const result = validateGstin(raw);
  return result.formatValid && result.checkDigitValid === true;
}
