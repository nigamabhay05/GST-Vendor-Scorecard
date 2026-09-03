import { asText } from './text';
/**
 * Invoice number normalisation.
 *
 * The same document is written `INV/2026/001` in the buyer's books and `INV-2026-1` on
 * the portal, because one was typed by a clerk and the other by the supplier's billing
 * software. Both must reduce to one key or the whole tool reports phantom gaps.
 *
 * The rule: uppercase, split into alphabetic and numeric runs, strip leading zeros from
 * each numeric run, discard everything else, rejoin.
 */

/** Uppercase, split into letter and digit runs, drop leading zeros, discard the rest. */
export function normalizeInvoiceNumber(raw: unknown): string {
  if (raw === null || raw === undefined) return '';

  const upper = asText(raw).toUpperCase();
  const runs = upper.match(/[A-Z]+|\d+/g);
  if (!runs) return '';

  return runs
    .map((run) => {
      if (/^\d+$/.test(run)) {
        // Strip leading zeros, but never reduce a run to nothing: "000" is "0".
        const stripped = run.replace(/^0+/, '');
        return stripped === '' ? '0' : stripped;
      }
      return run;
    })
    .join('');
}

/**
 * Levenshtein edit distance, used by match tier 5 to spot a transposed or dropped
 * character once GSTIN and value already agree.
 *
 * Bounded: once the best possible distance exceeds `max` the answer cannot change the
 * caller's decision, so it returns early. Invoice number lists are compared pairwise
 * across thousands of rows and the unbounded version dominates the run time.
 */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let previous = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      const best = Math.min(substitution, insertion, deletion);
      current[j] = best;
      if (best < rowMin) rowMin = best;
    }

    // Every remaining row can only add to the distance, so this bound is safe.
    if (rowMin > max) return max + 1;

    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length] ?? Number.POSITIVE_INFINITY;
}

/** True when the two normalised numbers are within `max` edits of each other. */
export function isWithinEditDistance(a: string, b: string, max: number): boolean {
  return levenshtein(a, b, max) <= max;
}

export interface CollisionGroup<T> {
  normalizedKey: string;
  members: T[];
}

/**
 * Finds groups where normalisation collapsed genuinely different invoice numbers onto
 * one key.
 *
 * This is the guard on the rule above. Normalisation is aggressive by design, and
 * aggressive normalisation eventually collides: a supplier issuing both `A/1` and
 * `A-01` in one month produces two distinct documents with one key. Merging them would
 * silently halve the recorded purchases, so instead both are flagged in Data Health and
 * matched on value and date rather than on number.
 *
 * Only *distinct* originals count as a collision. The same invoice number appearing
 * twice is a duplicate, which is a different finding.
 */
export function findNormalizationCollisions<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  originalOf: (item: T) => string,
): Array<CollisionGroup<T>> {
  const byKey = new Map<string, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    if (key === '') continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }

  const collisions: Array<CollisionGroup<T>> = [];
  for (const [normalizedKey, members] of byKey) {
    if (members.length < 2) continue;
    const distinctOriginals = new Set(members.map((m) => originalOf(m).trim().toUpperCase()));
    if (distinctOriginals.size > 1) {
      collisions.push({ normalizedKey, members });
    }
  }

  // Deterministic order, so the Data Health report is reproducible run to run.
  collisions.sort((a, b) => a.normalizedKey.localeCompare(b.normalizedKey));
  return collisions;
}
