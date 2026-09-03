import type {
  FileMapping,
  FilingFrequency,
  GstinIssue,
  InputFile,
  ParseOutcome,
  SupplierMasterRow,
} from '../types';
import { panKeyOf, validateGstin } from '../validate/gstin';
import {
  autoMapFields,
  detectHeaderRow,
  looksLikeTotalRow,
  readWorkbook,
  textOf,
  toSheetRows,
  type FieldSpec,
} from './csvExcel';
import { excerptOf, gstinIssueOf, previewOf } from './common';

/**
 * Supplier master parser (optional input).
 *
 * Two things turn a report into a workflow: contact details, so the follow-up email can
 * actually be addressed to someone, and the declared filing frequency, so a QRMP
 * supplier is not scored down for filing quarterly as the law permits. Without this
 * file both are inferred, and the interface says so.
 */

export const SUPPLIER_MASTER_FIELDS: FieldSpec[] = [
  {
    field: 'supplierName',
    label: 'Supplier name',
    hint: 'Matched to the register when a GSTIN is missing.',
    required: true,
    synonyms: ['supplier name', 'supplier', 'party name', 'vendor name', 'name', 'ledger name'],
  },
  {
    field: 'gstin',
    label: 'GSTIN',
    hint: 'The key used to attach these details to a supplier.',
    required: false,
    synonyms: ['gstin', 'gst no', 'gstin no', 'gst number', 'gstin/uin', 'supplier gstin'],
  },
  {
    field: 'contactPerson',
    label: 'Contact person',
    hint: 'Addressed by name in the generated follow-up email.',
    required: false,
    synonyms: ['contact person', 'contact', 'contact name', 'person', 'owner', 'spoc'],
  },
  {
    field: 'email',
    label: 'Email',
    hint: 'Recipient of the follow-up email.',
    required: false,
    synonyms: ['email', 'email id', 'e-mail', 'email address', 'mail'],
  },
  {
    field: 'phone',
    label: 'Phone',
    hint: 'Shown on the supplier drill-down.',
    required: false,
    synonyms: ['phone', 'mobile', 'contact no', 'phone no', 'telephone', 'mobile no'],
  },
  {
    field: 'paymentTermsDays',
    label: 'Payment terms (days)',
    hint: 'Context for how much leverage remains with this supplier.',
    required: false,
    synonyms: ['payment terms', 'payment terms days', 'credit days', 'terms', 'credit period'],
  },
  {
    field: 'filingFrequency',
    label: 'Filing frequency',
    hint: 'Monthly or quarterly. Quarterly filers are judged against their quarter.',
    required: false,
    synonyms: [
      'filing frequency',
      'frequency',
      'gstr1 frequency',
      'return frequency',
      'qrmp',
      'filing type',
    ],
  },
];

/**
 * Reads a filing frequency cell.
 *
 * Returns null rather than guessing when the cell says nothing recognisable: an
 * incorrect `quarterly` would excuse three months of genuine lateness, and an incorrect
 * `monthly` would penalise a supplier for using a scheme they are entitled to.
 */
export function parseFilingFrequency(raw: string): FilingFrequency | null {
  const text = raw.trim().toLowerCase();
  if (text === '') return null;
  if (/quarter|qrmp|\bq\b/.test(text)) return 'quarterly';
  if (/month|\bm\b|regular/.test(text)) return 'monthly';
  return null;
}

function parsePositiveInteger(raw: string): number | null {
  const digits = raw.replace(/[^\d-]/g, '');
  if (digits === '') return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

export function parseSupplierMaster(file: InputFile): ParseOutcome<SupplierMasterRow> {
  const workbook = readWorkbook(file.content, file.fileName);
  const sheet = workbook.sheets[0] ?? { name: file.fileName, rows: [] };

  const detection = detectHeaderRow(sheet.rows, SUPPLIER_MASTER_FIELDS);
  const fields = file.mapping?.fields ?? autoMapFields(detection.headers, SUPPLIER_MASTER_FIELDS);
  const dataRows = toSheetRows(sheet.rows, detection.headerRowIndex, detection.headers);

  const rows: SupplierMasterRow[] = [];
  const gstinIssues: GstinIssue[] = [];
  const droppedRows: ParseOutcome<SupplierMasterRow>['droppedRows'] = [];

  for (const row of dataRows) {
    if (looksLikeTotalRow(row)) continue;

    const supplierName = textOf(row, fields, 'supplierName');
    const gstinRaw = textOf(row, fields, 'gstin');
    const gstin = validateGstin(gstinRaw);

    if (supplierName === '' && gstin.normalized === null) {
      droppedRows.push({
        kind: 'supplierMaster',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        reason: 'No supplier name or GSTIN in the row.',
        excerpt: excerptOf(row.cells),
      });
      continue;
    }

    // Only a malformed GSTIN is worth reporting here: a master row with no GSTIN at all
    // is normal, since suppliers are matched by name in that case.
    if (!gstin.blank) {
      const issue = gstinIssueOf(
        'supplierMaster',
        file.fileName,
        row.sourceRow,
        supplierName,
        gstinRaw,
        gstin,
      );
      if (issue) gstinIssues.push(issue);
    }

    rows.push({
      sourceRow: row.sourceRow,
      supplierName,
      gstin: gstin.normalized,
      contactPerson: textOf(row, fields, 'contactPerson') || null,
      email: textOf(row, fields, 'email') || null,
      phone: textOf(row, fields, 'phone') || null,
      paymentTermsDays: parsePositiveInteger(textOf(row, fields, 'paymentTermsDays')),
      filingFrequency: parseFilingFrequency(textOf(row, fields, 'filingFrequency')),
    });
  }

  const mapping: FileMapping = {
    kind: 'supplierMaster',
    fileName: file.fileName,
    headerRowIndex: detection.headerRowIndex,
    availableHeaders: detection.headers,
    fields,
    preview: previewOf(dataRows),
  };

  return {
    rows,
    mapping,
    summary: {
      kind: 'supplierMaster',
      fileName: file.fileName,
      period: null,
      rowsRead: dataRows.length,
      rowsAccepted: rows.length,
      rowsDropped: droppedRows.length,
      headerRowIndex: detection.headerRowIndex,
    },
    gstinIssues,
    unparseableDates: [],
    ambiguousDateColumns: [],
    droppedRows,
  };
}

/** Index of master rows, GSTIN first and normalised name as the fallback. */
export function indexSupplierMaster(rows: readonly SupplierMasterRow[]): {
  byGstin: Map<string, SupplierMasterRow>;
  byPan: Map<string, SupplierMasterRow>;
  byName: Map<string, SupplierMasterRow>;
} {
  const byGstin = new Map<string, SupplierMasterRow>();
  const byPan = new Map<string, SupplierMasterRow>();
  const byName = new Map<string, SupplierMasterRow>();

  for (const row of rows) {
    if (row.gstin) {
      byGstin.set(row.gstin, row);
      const pan = panKeyOf(row.gstin);
      // First entry wins for a PAN: a supplier registered in several states shares one
      // contact, and the alternative is silently preferring whichever row sorted last.
      if (pan && !byPan.has(pan)) byPan.set(pan, row);
    }
    const nameKey = row.supplierName.trim().toLowerCase();
    if (nameKey !== '' && !byName.has(nameKey)) byName.set(nameKey, row);
  }

  return { byGstin, byPan, byName };
}
