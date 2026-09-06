import { describe, expect, it } from 'vitest';
import { loadSampleInputs } from '../../scripts/loadSample';
import { runAnalysis } from '../engine/index';

/**
 * End-to-end run over the committed sample dataset.
 *
 * This reads the same 25 files a user can download and open, through the same parsers,
 * matcher and scorer the browser uses. The snapshot on the headline KPIs is the tripwire:
 * if a change to any rule moves a number on the dashboard, it moves here first and has to
 * be looked at and accepted deliberately.
 *
 * Every seeded pattern from the brief is asserted individually, because a dataset that
 * silently stopped containing its own demonstration cases would still pass a KPI
 * snapshot while being worthless.
 */

const result = runAnalysis(loadSampleInputs());

const supplier = (name: string) => result.suppliers.find((s) => s.name.startsWith(name));

describe('sample dataset, end to end', () => {
  it('reads all 25 files without blocking', () => {
    expect(result.dataHealth.files).toHaveLength(25);
    expect(result.meta.periods).toHaveLength(8);
    expect(result.dataHealth.blocking).toBe(false);
    expect(result.dataHealth.ambiguousDateColumns).toHaveLength(0);
  });

  it('produces the expected headline figures', () => {
    expect({
      totalItcAtRisk: result.kpis.totalItcAtRisk,
      expectedCashLoss: result.kpis.expectedCashLoss,
      totalInScopeItc: result.kpis.totalInScopeItc,
      redSupplierCount: result.kpis.redSupplierCount,
      deemedAcceptedCount: result.kpis.deemedAcceptedCount,
      suppliersScored: result.kpis.suppliersScored,
      suppliersInsufficientHistory: result.kpis.suppliersInsufficientHistory,
    }).toMatchInlineSnapshot(`
      {
        "deemedAcceptedCount": 31,
        "expectedCashLoss": 1430607.28,
        "redSupplierCount": 2,
        "suppliersInsufficientHistory": 3,
        "suppliersScored": 22,
        "totalInScopeItc": 11272680,
        "totalItcAtRisk": 1747800,
      }
    `);
  });

  it('is deterministic: the same files produce byte-identical output', () => {
    const again = runAnalysis(loadSampleInputs());
    expect(JSON.stringify(again.matches)).toBe(JSON.stringify(result.matches));
    expect(JSON.stringify(again.kpis)).toBe(JSON.stringify(result.kpis));
  });

  it('finishes fast enough for the one-click demo', () => {
    // The Start screen promises a full dashboard in under three seconds.
    expect(result.meta.runtimeMs).toBeLessThan(3000);
  });
});

describe('seeded patterns', () => {
  it('1. a chronic late filer is flagged red with a real delay', () => {
    const mahesh = supplier('Mahesh Steel');
    expect(mahesh?.flag).toBe('red');
    expect(mahesh?.components.avgDelayMonths).toBeGreaterThan(0);
    expect(mahesh?.itcAtRisk).toBeGreaterThan(100000);
  });

  it('2. a supplier the buyer rejected is not blamed for it', () => {
    // The story that proves the attribution layer earns its place: without the IMS log
    // this supplier looks like a total failure.
    const precision = supplier('Precision Components');
    expect(precision?.components.matchRate).toBe(1);
    expect(precision?.components.disputeRate).toBe(0);
    expect(precision?.attributionValue.recipient_rejected).toBeGreaterThan(0);
    expect(precision?.attributionValue.supplier_never_reported).toBe(0);
    expect(precision?.suggestedAction).toMatch(/your own IMS decisions/i);
    // The money is still reported: the buyer has genuinely lost this credit.
    expect(precision?.itcAtRisk).toBeGreaterThan(0);
  });

  it('3. a quarterly QRMP filer scores green despite apparent delay', () => {
    const kaveri = supplier('Kaveri Packaging');
    expect(kaveri?.filingFrequency).toBe('quarterly');
    expect(kaveri?.filingFrequencySource).toBe('master');
    expect(kaveri?.flag).toBe('green');
    expect(kaveri?.components.avgDelayMonths).toBe(0);
  });

  it('4a. a supplier reporting under another state GSTIN fires match tier 4', () => {
    const tier4 = result.matches.filter((m) => m.tier === 4);
    expect(tier4.length).toBeGreaterThan(0);
    expect(tier4.every((m) => m.status === 'gstin_state_mismatch')).toBe(true);
    // Found, but usable as neither received credit nor at-risk credit.
    expect(tier4.every((m) => m.taxAtRisk === 0 && m.taxReceived === 0)).toBe(true);
  });

  it('4b. a supplier quoting the wrong buyer GSTIN shows as never reported', () => {
    const deccan = supplier('Deccan Freight');
    expect(deccan?.components.matchRate).toBe(0);
    expect(deccan?.flag).toBe('red');
    expect(deccan?.attributionValue.supplier_never_reported).toBeGreaterThan(0);
  });

  it('5. a supplier clean for months then collapsing shows it in the monthly series', () => {
    const anand = supplier('Anand Polymers');
    const series = anand?.monthlyMatchRate.filter((m) => m.matchRate !== null) ?? [];
    expect(series.length).toBeGreaterThanOrEqual(3);
    expect(series[0]?.matchRate).toBe(1);
    expect(series[series.length - 1]?.matchRate).toBe(0);
  });

  it('6. invoice number format drift is caught by tier 3, not reported as a gap', () => {
    const tier3 = result.matches.filter((m) => m.tier === 3);
    expect(tier3.length).toBeGreaterThan(0);
    expect(tier3.every((m) => m.creditTreatment === 'received')).toBe(true);
    expect(tier3.some((m) => m.supplierName.startsWith('Surya'))).toBe(true);
  });

  it('7. forgotten pending records age towards the 30 November deadline', () => {
    const ageing = result.pendingAgeing;
    expect(ageing.rows.length).toBeGreaterThanOrEqual(2);
    expect(ageing.rows.every((r) => r.section16_4Deadline === '2026-11-30')).toBe(true);
    expect(ageing.rows.some((r) => r.deadlineFlag === 'red')).toBe(true);
    expect(ageing.atRiskOfExpiryTaxValue).toBeGreaterThan(0);
    // And they are attributed to the buyer, not the supplier.
    const held = result.attributionSplit.find((e) => e.attribution === 'recipient_kept_pending');
    expect(held?.count).toBeGreaterThan(0);
  });

  it('8. a rejected credit note is surfaced on its own', () => {
    expect(result.creditNotes.rejected.count).toBeGreaterThan(0);
    expect(result.creditNotes.rejected.rows[0]?.remark).toMatch(/rejected/i);
  });

  it('9. blocked 17(5) purchases are excluded from at-risk but still counted', () => {
    const blocked = result.outOfScope.find((s) => s.reason === 'blocked_17_5');
    expect(blocked?.rows).toBeGreaterThan(0);
    expect(blocked?.taxValue).toBeGreaterThan(0);

    // Nothing blocked contributes to exposure anywhere.
    const blockedMatches = result.matches.filter((m) => m.scopeReason === 'blocked_17_5');
    expect(blockedMatches.every((m) => m.taxAtRisk === 0)).toBe(true);
    expect(supplier('Metro Motors')?.itcAtRisk).toBe(0);
  });

  it('10. the deliberately dirty rows are all reported in Data Health', () => {
    const health = result.dataHealth;
    expect(health.gstinIssues.filter((i) => i.problem === 'blank')).toHaveLength(3);
    expect(health.gstinIssues.filter((i) => i.problem === 'check_digit')).toHaveLength(1);
    // Grand-total lines: one per register file, dropped with a reason.
    expect(health.droppedRows).toHaveLength(8);
    expect(health.droppedRows.every((r) => /total/i.test(r.reason))).toBe(true);
    // Amounts stored as text with Indian grouping parsed without loss.
    expect(health.unparseableDates).toHaveLength(0);
  });

  it('a blank GSTIN does not spawn a second entry for the same supplier', () => {
    const names = result.suppliers.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('generates follow-up emails only for suppliers worth chasing', () => {
    expect(result.followUpEmails.length).toBeGreaterThan(0);
    // Never chase a supplier for credit the buyer's own team rejected.
    expect(result.followUpEmails.some((e) => e.supplierName.startsWith('Precision'))).toBe(false);
    expect(result.followUpEmails[0]?.body).toContain('GSTR-1');
  });

  it('reports nothing as not-implemented for the Excel sample', () => {
    expect(result.notImplemented).toEqual([]);
  });
});
