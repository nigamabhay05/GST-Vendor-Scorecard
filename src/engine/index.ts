import { SCORING, ENGINE_VERSION } from './config';
import {
  attributeAll,
  buildAttributionSplit,
  buildDeemedAcceptanceReport,
  type AttributionContext,
} from './analyse/attribution';
import {
  buildCreditNoteReport,
  computeRecovery,
  creditNoteIssueValueBySupplier,
  buildHeadlineKpis,
  totalInScopeItcOf,
} from './analyse/exposure';
import { buildPendingAgeing } from './analyse/pendingAgeing';
import { inferFilingFrequency, scoreSupplier, supplierKey } from './analyse/supplierScore';
import { runMatchPipeline } from './match/pipeline';
import { comparePeriods } from './normalize/period';
import { parseGstr2b } from './parse/gstr2b';
import { indexImsLog, parseImsLog } from './parse/imsLog';
import { parsePurchaseRegister } from './parse/purchaseRegister';
import { indexSupplierMaster, parseSupplierMaster } from './parse/supplierMaster';
import { buildFollowUpEmails } from './export/followUpEmails';
import type {
  AnalysisInputs,
  AnalysisResult,
  BookRow,
  FilingFrequency,
  ImsLogRow,
  ParseOutcome,
  PeriodKey,
  Portal2bRow,
  SupplierMasterRow,
  SupplierScorecardEntry,
} from './types';
import { buildDataHealthReport } from './validate/dataHealth';
import { isGstinFullyValid } from './validate/gstin';

/**
 * The engine's single entry point.
 *
 * `runAnalysis` takes files in memory and returns everything the interface renders.
 * There is no other way in and no other way out: if a number appears on screen, it is a
 * field of the object this function returns.
 *
 * Pure and synchronous, with no DOM and no network. It runs unchanged inside a Web
 * Worker in the browser and inside a Node script from the command line, which is what
 * makes `npm run verify` a genuine check on the same code the user sees.
 */
export function runAnalysis(inputs: AnalysisInputs): AnalysisResult {
  const startedAt = Date.now();

  const bookRows: BookRow[] = [];
  const portalRows: Portal2bRow[] = [];
  const imsRows: ImsLogRow[] = [];
  const masterRows: SupplierMasterRow[] = [];
  const outcomes: Array<ParseOutcome<unknown>> = [];
  const notImplemented: string[] = [];

  const periodsWithImsLog = new Set<PeriodKey>();

  for (const file of inputs.files) {
    switch (file.kind) {
      case 'purchaseRegister': {
        const outcome = parsePurchaseRegister(file, {
          dateFormatAnswers: inputs.dateFormatAnswers,
          extraBlockedSuppliers: inputs.extraBlockedSuppliers,
        });
        bookRows.push(...outcome.rows);
        outcomes.push(outcome);
        break;
      }
      case 'gstr2b': {
        const outcome = parseGstr2b(file, { dateFormatAnswers: inputs.dateFormatAnswers });
        portalRows.push(...outcome.rows);
        outcomes.push(outcome);
        if (outcome.notImplemented) notImplemented.push(...outcome.notImplemented);
        break;
      }
      case 'imsLog': {
        const outcome = parseImsLog(file, { dateFormatAnswers: inputs.dateFormatAnswers });
        imsRows.push(...outcome.rows);
        outcomes.push(outcome);
        if (file.period) periodsWithImsLog.add(file.period);
        break;
      }
      case 'supplierMaster': {
        const outcome = parseSupplierMaster(file);
        masterRows.push(...outcome.rows);
        outcomes.push(outcome);
        break;
      }
    }
  }

  const dataHealth = buildDataHealthReport({ outcomes, bookRows });

  const periods = [
    ...new Set([
      ...bookRows.map((row) => row.period),
      ...portalRows.map((row) => row.period),
    ]),
  ]
    .filter((period) => period !== '')
    .sort(comparePeriods);

  const scoringPeriods = periods.slice(-SCORING.lookbackPeriods);

  const master = indexSupplierMaster(masterRows);
  const imsIndex = indexImsLog(imsRows);

  /*
   * Filing frequency has to be known before matching, because it decides what counts as
   * on time. The supplier master is believed where it speaks; otherwise the pattern in
   * the 2B filing dates is inferred, and the inference is marked low confidence
   * everywhere it affects a score.
   */
  const filingDatesByGstin = new Map<string, string[]>();
  for (const row of portalRows) {
    if (!row.supplierGstin || !row.gstr1FilingDate) continue;
    const list = filingDatesByGstin.get(row.supplierGstin) ?? [];
    list.push(row.gstr1FilingDate);
    filingDatesByGstin.set(row.supplierGstin, list);
  }

  const frequencyCache = new Map<string, FilingFrequency>();
  const filingFrequencyOf = (gstin: string | null, panKey: string | null): FilingFrequency => {
    const key = gstin ?? panKey ?? '';
    const cached = frequencyCache.get(key);
    if (cached) return cached;

    const masterRow =
      (gstin ? master.byGstin.get(gstin) : undefined) ??
      (panKey ? master.byPan.get(panKey) : undefined);

    let frequency: FilingFrequency;
    if (masterRow?.filingFrequency) {
      frequency = masterRow.filingFrequency;
    } else {
      const dates = gstin ? (filingDatesByGstin.get(gstin) ?? []) : [];
      frequency = inferFilingFrequency(dates).frequency;
    }

    frequencyCache.set(key, frequency);
    return frequency;
  };

  const lastLoadedPeriod =
    [...new Set(portalRows.map((row) => row.period))].filter(Boolean).sort(comparePeriods).at(-1) ??
    null;

  const matches = runMatchPipeline({
    bookRows,
    portalRows,
    filingFrequencyOf,
    lastLoadedPeriod,
  });

  const attributionContext: AttributionContext = { imsIndex, periodsWithImsLog };
  attributeAll(matches, attributionContext);

  const recovery = computeRecovery(matches, periods);
  const creditNoteIssues = creditNoteIssueValueBySupplier(bookRows, portalRows);
  const totalInScopeItc = totalInScopeItcOf(matches);

  /*
   * A register row with a blank GSTIN still belongs to a supplier. Resolving it by name
   * against the GSTINs seen elsewhere keeps those rows with their supplier instead of
   * spawning a second, phantom entry in the scorecard for the same business.
   */
  const gstinByName = new Map<string, string>();
  for (const row of bookRows) {
    // Only GSTINs that pass their own check digit are allowed to define a supplier, so
    // a mistyped one can never become the identity everything else is grouped under.
    if (!row.supplierGstin || !isGstinFullyValid(row.supplierGstin)) continue;
    const nameKey = row.supplierName.trim().toLowerCase();
    if (nameKey !== '' && !gstinByName.has(nameKey)) gstinByName.set(nameKey, row.supplierGstin);
  }

  /**
   * The GSTIN a document should be grouped under.
   *
   * A blank GSTIN, or one whose check digit fails, is not enough to identify a supplier
   * -- but the name usually is. Falling back to the name keeps a mistyped or missing
   * row with its supplier instead of splitting one business across two scorecard rows,
   * which is both wrong and the kind of thing that makes a reader distrust the table.
   *
   * Two *valid* GSTINs are never merged, even under one name: that is a supplier with
   * more than one state registration, which is what match tier 4 exists to report.
   */
  const resolveGstin = (gstin: string | null, name: string): string | null => {
    if (gstin && isGstinFullyValid(gstin)) return gstin;
    return gstinByName.get(name.trim().toLowerCase()) ?? gstin;
  };

  // Group results by supplier before scoring, so each supplier is scored once over all
  // of their documents rather than per period.
  const bySupplier = new Map<string, typeof matches>();
  for (const result of matches) {
    if (result.status === 'missing_in_books') continue;
    const key = supplierKey(
      resolveGstin(result.supplierGstin, result.supplierName),
      result.supplierName,
    );
    const bucket = bySupplier.get(key) ?? [];
    bucket.push(result);
    bySupplier.set(key, bucket);
  }

  const suppliers: SupplierScorecardEntry[] = [];
  for (const [key, results] of bySupplier) {
    const first = results[0];
    if (!first) continue;

    const gstin = resolveGstin(first.supplierGstin, first.supplierName);
    const masterRow =
      (gstin ? master.byGstin.get(gstin) : undefined) ??
      master.byName.get(first.supplierName.trim().toLowerCase());

    suppliers.push(
      scoreSupplier({
        key,
        gstin,
        panKey: first.panKey,
        name: masterRow?.supplierName ?? first.supplierName,
        results,
        scoringPeriods,
        master: masterRow,
        portalRows: portalRows.filter((row) => row.supplierGstin === gstin),
        totalInScopeItc,
        globalRecovery: recovery.global,
        supplierRecovery: recovery.bySupplier.get(
          gstin ?? `name:${first.supplierName.toLowerCase()}`,
        ) ?? { resolved: 0, recovered: 0 },
        creditNoteIssueValue:
          creditNoteIssues.get(gstin ?? `name:${first.supplierName.toLowerCase()}`) ?? 0,
      }),
    );
  }

  // Worst first: the scorecard's job is to put the phone call at the top of the screen.
  suppliers.sort(
    (a, b) =>
      b.expectedCashLoss - a.expectedCashLoss ||
      (a.score ?? 999) - (b.score ?? 999) ||
      a.name.localeCompare(b.name),
  );

  const deemedAcceptance = buildDeemedAcceptanceReport(matches, attributionContext);

  return {
    meta: {
      asOf: inputs.asOf,
      periods,
      scoringPeriods,
      buyerGstin: inputs.buyerGstin,
      isSampleData: inputs.isSampleData,
      engineVersion: ENGINE_VERSION,
      runtimeMs: Date.now() - startedAt,
    },
    dataHealth,
    kpis: buildHeadlineKpis(
      suppliers,
      totalInScopeItc,
      deemedAcceptance.count,
      deemedAcceptance.share,
    ),
    suppliers,
    matches,
    attributionSplit: buildAttributionSplit(matches),
    deemedAcceptance,
    pendingAgeing: buildPendingAgeing({ imsRows, results: matches, asOf: inputs.asOf }),
    creditNotes: buildCreditNoteReport(bookRows, portalRows, imsIndex),
    outOfScope: dataHealth.scopeExclusions,
    mappings: outcomes.map((outcome) => outcome.mapping),
    followUpEmails: buildFollowUpEmails(suppliers, inputs.asOf),
    notImplemented,
  };
}

export { runAnalysis as default };
