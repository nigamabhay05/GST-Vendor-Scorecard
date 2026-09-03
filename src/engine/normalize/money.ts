import { MONEY } from '../config';
import { asText } from './text';
import type { Rupees, TaxAmounts, TaxHead } from '../types';

/**
 * Money parsing for spreadsheet cells that were never meant to be parsed.
 *
 * A real purchase register contains amounts as numbers, as text with thousands
 * separators, with a rupee sign, with a non-breaking space where a thin space was
 * intended, and with negatives written the accountant's way -- in parentheses. All of
 * those mean the same thing and all of them appear in the same column.
 */

export interface MoneyParse {
  value: Rupees | null;
  raw: string;
  problem: 'blank' | 'unparseable' | null;
}

const BLANK_TOKENS = new Set(['', '-', '--', 'nil', 'na', 'n/a', 'null', 'undefined']);

/**
 * Characters and tokens with no arithmetic meaning. `Dr` and `Cr` are stripped without
 * changing the sign: in a purchase register the direction of a document is carried by
 * its document type, not by a ledger suffix, and inferring a credit note from the
 * letters "Cr" in an amount cell would be a guess about someone else's export
 * settings. See ASSUMPTIONS.md.
 */
const STRIP_PATTERN = new RegExp(
  `(${MONEY.strippedCharacters.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|\\bdr\\b|\\bcr\\b)`,
  'gi',
);

/** Rounds to two decimals without the floating-point drift of `toFixed` round-tripping. */
export function roundRupees(value: number): Rupees {
  return Math.round(value * 100) / 100;
}

export function parseMoney(raw: unknown): MoneyParse {
  if (raw === null || raw === undefined) {
    return { value: null, raw: '', problem: 'blank' };
  }

  // A number that arrived as a number needs no interpretation.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: null, raw: String(raw), problem: 'unparseable' };
    return { value: roundRupees(raw), raw: String(raw), problem: null };
  }

  if (typeof raw === 'boolean') {
    return { value: null, raw: String(raw), problem: 'unparseable' };
  }

  const rawText = asText(raw);
  const trimmed = rawText.trim();

  if (BLANK_TOKENS.has(trimmed.toLowerCase())) {
    return { value: null, raw: rawText, problem: 'blank' };
  }

  let text = trimmed.replace(STRIP_PATTERN, '').trim();

  // Accountants write a negative in parentheses: (1,200) is -1200.
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // A trailing minus is a second convention for the same thing.
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }

  if (text === '') {
    return { value: null, raw: rawText, problem: 'blank' };
  }

  // After stripping, anything that is not a plain decimal is not an amount.
  if (!/^\d*\.?\d+$/.test(text) && !/^\d+\.$/.test(text)) {
    return { value: null, raw: rawText, problem: 'unparseable' };
  }

  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) {
    return { value: null, raw: rawText, problem: 'unparseable' };
  }

  return { value: roundRupees(negative ? -parsed : parsed), raw: rawText, problem: null };
}

/** Parses an amount, treating anything unusable as zero. For total columns where a
 *  blank genuinely means "no tax under this head". */
export function parseMoneyOrZero(raw: unknown): Rupees {
  return parseMoney(raw).value ?? 0;
}

/**
 * Two amounts are equal when they differ by no more than the configured tolerance.
 * Never compare rupee figures with `===`: the register rounds each line and the portal
 * rounds the document, so exact equality fails on documents that are in fact identical.
 */
export function amountsEqual(a: Rupees, b: Rupees): boolean {
  return Math.abs(a - b) <= MONEY.toleranceRupees;
}

export function totalTax(tax: TaxAmounts): Rupees {
  return roundRupees(tax.cgst + tax.sgst + tax.igst + tax.cess);
}

export function emptyTax(): TaxAmounts {
  return { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
}

/**
 * Which tax heads a document carries.
 *
 * `intra` is CGST+SGST (supplier and buyer in the same state), `inter` is IGST. A
 * document booked one way and reported the other is a tax head mismatch: the credit
 * exists but under the wrong head, which is a different problem from a missing invoice
 * and needs a different phone call.
 */
export function taxHeadOf(tax: TaxAmounts): TaxHead {
  const intra = tax.cgst > 0 || tax.sgst > 0;
  const inter = tax.igst > 0;
  if (intra && inter) return 'mixed';
  if (intra) return 'intra';
  if (inter) return 'inter';
  return 'none';
}

/** True when books and portal disagree about the head, both being definite about it. */
export function isTaxHeadMismatch(books: TaxHead, portal: TaxHead): boolean {
  if (books === 'none' || portal === 'none') return false;
  if (books === 'mixed' || portal === 'mixed') return false;
  return books !== portal;
}
