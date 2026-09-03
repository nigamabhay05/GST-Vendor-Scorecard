import type { AnalysisResult, FollowUpEmail } from '../types';

/**
 * CSV builders.
 *
 * Pure string producers: nothing here touches the DOM or triggers a download. The UI
 * decides when a file is saved, which keeps these testable and keeps the engine free of
 * browser APIs.
 */

/** Quotes a field only when it needs it, and never lets a value break the row. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);

  /*
   * A leading =, +, - or @ makes Excel treat a cell as a formula. A supplier name that
   * begins with one of those would be executed rather than displayed, which is a real
   * injection route in a file people open in Excel without thinking. Prefixing an
   * apostrophe forces it to stay text.
   */
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return /["\n,\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

function percent(value: number | null): string {
  return value === null ? '' : (value * 100).toFixed(1);
}

/** The supplier scorecard, one row per supplier, in the order shown on screen. */
export function scorecardCsv(result: AnalysisResult): string {
  const rows: Array<Array<string | number | null>> = [
    [
      'Supplier',
      'GSTIN',
      'Score',
      'Flag',
      'Periods with data',
      'Match rate %',
      'Average delay (months)',
      'Volatility',
      'Dispute rate %',
      'ITC at risk',
      'Expected cash loss',
      'Recovery rate used',
      'Recovery basis',
      'Recovery sample size',
      'Needs correction',
      'Concentration %',
      'Filing frequency',
      'Filing frequency source',
      'Suggested action',
      'Contact',
      'Email',
      'Phone',
    ],
  ];

  for (const supplier of result.suppliers) {
    rows.push([
      supplier.name,
      supplier.gstin,
      supplier.score,
      flagLabel(supplier.flag),
      supplier.periodsWithData,
      percent(supplier.components.matchRate),
      supplier.components.avgDelayMonths.toFixed(2),
      supplier.components.volatility.toFixed(3),
      percent(supplier.components.disputeRate),
      supplier.itcAtRisk,
      supplier.expectedCashLoss,
      percent(supplier.recoveryBasis.rate),
      supplier.recoveryBasis.source,
      supplier.recoveryBasis.sampleSize,
      supplier.needsCorrectionValue,
      percent(supplier.concentration),
      supplier.filingFrequency,
      supplier.filingFrequencySource,
      supplier.suggestedAction,
      supplier.contact?.contactPerson ?? '',
      supplier.contact?.email ?? '',
      supplier.contact?.phone ?? '',
    ]);
  }

  return toCsv(rows);
}

export function flagLabel(flag: string): string {
  switch (flag) {
    case 'green':
      return 'OK';
    case 'amber':
      return 'Watch';
    case 'red':
      return 'At risk';
    default:
      return 'Insufficient history';
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'matched':
      return 'Matched';
    case 'value_mismatch':
      return 'Value mismatch';
    case 'invoice_number_mismatch':
      return 'Invoice number mismatch';
    case 'gstin_state_mismatch':
      return 'GSTIN / state mismatch';
    case 'probable_match':
      return 'Probable match, review';
    case 'missing_in_2b':
      return 'Missing in GSTR-2B';
    case 'missing_in_books':
      return 'Missing in books';
    default:
      return status;
  }
}

export function attributionLabel(attribution: string): string {
  switch (attribution) {
    case 'supplier_never_reported':
      return 'Supplier never reported';
    case 'supplier_reported_late':
      return 'Supplier reported late';
    case 'recipient_rejected':
      return 'You rejected it in IMS';
    case 'recipient_kept_pending':
      return 'You kept it pending in IMS';
    case 'deemed_accepted':
      return 'Deemed accepted';
    default:
      return 'Not attributed';
  }
}

export function scopeReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'blocked_17_5':
      return 'Blocked under section 17(5)';
    case 'reverse_charge':
      return 'Reverse charge';
    case 'isd':
      return 'ISD';
    case 'import_of_services':
      return 'Import of services';
    case 'pos_restricted':
      return 'Place of supply restricted';
    case 'credit_note':
      return 'Credit note';
    case 'itc_ineligible_flag':
      return 'Marked ineligible in the register';
    default:
      return '';
  }
}

/** Every document, with its match status, tier and attribution. */
export function invoiceDetailCsv(result: AnalysisResult): string {
  const rows: Array<Array<string | number | null>> = [
    [
      'Supplier',
      'GSTIN',
      'Invoice number',
      'Invoice date',
      'Document type',
      'Status',
      'Match tier',
      'Credit treatment',
      'Expected 2B period',
      'Actual 2B period',
      'Delay (months)',
      'Delay beyond allowed (months)',
      'On time',
      'Not yet due',
      'Tax received',
      'Tax at risk',
      'Tax head mismatch',
      'Attribution',
      'In scope',
      'Excluded because',
    ],
  ];

  for (const match of result.matches) {
    rows.push([
      match.supplierName,
      match.supplierGstin,
      match.invoiceNumber,
      match.invoiceDate,
      match.docType,
      statusLabel(match.status),
      match.tier,
      match.creditTreatment,
      match.expectedPeriod,
      match.actualPeriod,
      match.delayMonths,
      match.excessDelayMonths,
      match.onTime === null ? '' : match.onTime ? 'Yes' : 'No',
      match.notYetDue ? 'Yes' : 'No',
      match.taxReceived,
      match.taxAtRisk,
      match.taxHeadMismatch ? 'Yes' : 'No',
      attributionLabel(match.attribution),
      match.inScope ? 'Yes' : 'No',
      scopeReasonLabel(match.scopeReason),
    ]);
  }

  return toCsv(rows);
}

/** The Data Health findings, so a reviewer can work through them off-screen. */
export function dataHealthCsv(result: AnalysisResult): string {
  const rows: Array<Array<string | number | null>> = [['Finding', 'File', 'Row', 'Detail']];

  for (const issue of result.dataHealth.gstinIssues) {
    rows.push([
      `GSTIN ${issue.problem.replace('_', ' ')}`,
      issue.fileName,
      issue.sourceRow,
      `${issue.supplierName} ${issue.value}`.trim(),
    ]);
  }
  for (const date of result.dataHealth.unparseableDates) {
    rows.push(['Unreadable date', date.fileName, date.sourceRow, `${date.column}: ${date.value}`]);
  }
  for (const dropped of result.dataHealth.droppedRows) {
    rows.push(['Row dropped', dropped.fileName, dropped.sourceRow, dropped.reason]);
  }
  for (const collision of result.dataHealth.normalizationCollisions) {
    rows.push([
      'Invoice number collision',
      '',
      '',
      `${collision.supplierName}: ${collision.originalInvoiceNumbers.join(' and ')} both become ${collision.normalizedKey}`,
    ]);
  }
  for (const duplicate of result.dataHealth.duplicateInvoices) {
    rows.push([
      'Duplicate invoice number',
      '',
      '',
      `${duplicate.supplierName}: ${duplicate.invoiceNumber} appears ${String(duplicate.rowIds.length)} times`,
    ]);
  }
  for (const exclusion of result.dataHealth.scopeExclusions) {
    rows.push([
      'Excluded from at-risk',
      '',
      '',
      `${scopeReasonLabel(exclusion.reason)}: ${String(exclusion.rows)} rows, tax ${String(exclusion.taxValue)}`,
    ]);
  }

  return toCsv(rows);
}

/** Every generated follow-up email as one plain-text file. */
export function followUpEmailsText(emails: readonly FollowUpEmail[]): string {
  if (emails.length === 0) {
    return 'No follow-up emails were generated: no supplier has credit at risk attributable to them.\n';
  }

  return emails
    .map((email) =>
      [
        '='.repeat(72),
        `To:      ${email.to ?? '(no email address in the supplier master)'}`,
        `Subject: ${email.subject}`,
        '='.repeat(72),
        '',
        email.body,
        '',
      ].join('\n'),
    )
    .join('\n');
}
