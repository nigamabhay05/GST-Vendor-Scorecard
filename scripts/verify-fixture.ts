 
import { runAnalysis } from '../src/engine/index';
import { loadSampleInputs } from './loadSample';

/**
 * Headless verification.
 *
 * This is the phase-5 gate from the build plan: the entire engine runs in Node, over the
 * committed sample files, with no browser and no UI anywhere in the process. If the
 * figures here are wrong, they are wrong in the app too -- and they are checked here
 * first, before a single screen exists to hide them behind.
 *
 * Run with `npm run verify`.
 */

function inr(value: number): string {
  const rounded = Math.round(value);
  const text = String(Math.abs(rounded));
  const last3 = text.slice(-3);
  const rest = text.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${rounded < 0 ? '-' : ''}Rs ${grouped}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function main() {
  const inputs = loadSampleInputs();
  const result = runAnalysis(inputs);

  console.log('');
  console.log('=== Vendor GST Compliance Scorecard - headless engine run ===');
  console.log(`engine ${result.meta.engineVersion}   as of ${result.meta.asOf}   ${String(result.meta.runtimeMs)} ms`);
  console.log(`files ${String(inputs.files.length)}   periods ${result.meta.periods.join(', ')}`);
  console.log(`scoring window: ${result.meta.scoringPeriods.join(', ')}`);

  console.log('');
  console.log('--- headline ---');
  console.log(`  ITC at risk            ${inr(result.kpis.totalItcAtRisk)}`);
  console.log(`  expected cash loss     ${inr(result.kpis.expectedCashLoss)}`);
  console.log(`  total in-scope ITC     ${inr(result.kpis.totalInScopeItc)}`);
  console.log(`  red suppliers          ${String(result.kpis.redSupplierCount)}`);
  console.log(
    `  deemed accepted        ${String(result.kpis.deemedAcceptedCount)} records (${pct(result.kpis.deemedAcceptedShare)})`,
  );
  console.log(
    `  scored / no history    ${String(result.kpis.suppliersScored)} / ${String(result.kpis.suppliersInsufficientHistory)}`,
  );

  console.log('');
  console.log('--- matching ---');
  const byStatus = new Map<string, number>();
  for (const match of result.matches) {
    byStatus.set(match.status, (byStatus.get(match.status) ?? 0) + 1);
  }
  for (const [status, count] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(24)} ${String(count)}`);
  }
  console.log(`  tax head mismatches      ${String(result.matches.filter((m) => m.taxHeadMismatch).length)}`);

  console.log('');
  console.log('--- attribution ---');
  for (const entry of result.attributionSplit) {
    if (entry.count === 0) continue;
    const marker = entry.isRecipientCause ? ' (your own control)' : '';
    console.log(
      `  ${entry.attribution.padEnd(24)} ${String(entry.count).padStart(4)}  ${inr(entry.taxValue).padStart(14)}${marker}`,
    );
  }

  console.log('');
  console.log('--- data health ---');
  const health = result.dataHealth;
  console.log(`  files read               ${String(health.files.length)}`);
  console.log(`  rows read                ${String(health.files.reduce((s, f) => s + f.rowsRead, 0))}`);
  console.log(`  rows dropped             ${String(health.droppedRows.length)}`);
  console.log(`  blank GSTINs             ${String(health.gstinIssues.filter((i) => i.problem === 'blank').length)}`);
  console.log(`  malformed GSTINs         ${String(health.gstinIssues.filter((i) => i.problem === 'malformed').length)}`);
  console.log(`  check-digit warnings     ${String(health.gstinIssues.filter((i) => i.problem === 'check_digit').length)}`);
  console.log(`  unparseable dates        ${String(health.unparseableDates.length)}`);
  console.log(`  ambiguous date columns   ${String(health.ambiguousDateColumns.length)}`);
  console.log(`  normalisation collisions ${String(health.normalizationCollisions.length)}`);
  console.log(`  duplicate invoices       ${String(health.duplicateInvoices.length)}`);
  console.log(`  blocking                 ${String(health.blocking)}`);
  for (const exclusion of health.scopeExclusions) {
    console.log(
      `  excluded: ${exclusion.reason.padEnd(20)} ${String(exclusion.rows).padStart(4)} rows  ${inr(exclusion.taxValue)}`,
    );
  }

  console.log('');
  console.log('--- pending ageing ---');
  for (const [bucket, totals] of Object.entries(result.pendingAgeing.byBucket)) {
    if (totals.rows === 0) continue;
    console.log(`  ${bucket.padEnd(8)} ${String(totals.rows).padStart(3)} rows  ${inr(totals.taxValue)}`);
  }
  console.log(`  at risk of expiry        ${inr(result.pendingAgeing.atRiskOfExpiryTaxValue)}`);
  for (const row of result.pendingAgeing.rows.slice(0, 4)) {
    console.log(
      `    ${row.supplierName.slice(0, 26).padEnd(26)} ${row.invoiceNumber.padEnd(16)} ` +
        `${String(row.daysToDeadline).padStart(4)}d to ${row.section16_4Deadline} [${row.deadlineFlag}]`,
    );
  }

  console.log('');
  console.log('--- credit notes ---');
  console.log(`  total                    ${String(result.creditNotes.total.count)}  ${inr(result.creditNotes.total.taxValue)}`);
  console.log(`  rejected in IMS          ${String(result.creditNotes.rejected.count)}  ${inr(result.creditNotes.rejected.taxValue)}`);
  for (const row of result.creditNotes.rejected.rows) {
    console.log(`    ${row.supplierName} ${row.invoiceNumber} ${inr(row.taxValue)} - ${row.remark ?? ''}`);
  }

  console.log('');
  console.log('--- suppliers (worst first) ---');
  console.log(
    `  ${'supplier'.padEnd(30)} ${'score'.padStart(5)} ${'flag'.padEnd(22)} ${'match'.padStart(6)} ${'delay'.padStart(6)} ${'at risk'.padStart(13)} ${'exp loss'.padStart(13)}  basis`,
  );
  for (const supplier of result.suppliers.slice(0, 14)) {
    console.log(
      `  ${supplier.name.slice(0, 30).padEnd(30)} ` +
        `${(supplier.score === null ? '-' : String(supplier.score)).padStart(5)} ` +
        `${supplier.flag.padEnd(22)} ` +
        `${pct(supplier.components.matchRate).padStart(6)} ` +
        `${supplier.components.avgDelayMonths.toFixed(1).padStart(6)} ` +
        `${inr(supplier.itcAtRisk).padStart(13)} ` +
        `${inr(supplier.expectedCashLoss).padStart(13)}  ` +
        `${supplier.recoveryBasis.source}/${String(supplier.recoveryBasis.sampleSize)}`,
    );
  }

  console.log('');
  console.log(`--- follow-up emails generated: ${String(result.followUpEmails.length)} ---`);
  if (result.notImplemented.length > 0) {
    console.log('');
    console.log('--- not implemented ---');
    for (const item of result.notImplemented) console.log(`  ${item}`);
  }
  console.log('');
}

main();
