import { normalizeInvoiceNumber } from '../normalize/invoiceNumber';
import { parseMoneyOrZero } from '../normalize/money';
import type {
  FileMapping,
  GstinIssue,
  ImsAction,
  ImsLogRow,
  InputFile,
  ParseOutcome,
  SlashDateFormatAnswers,
  UnparseableDate,
} from '../types';
import { parseDateOnly } from '../validate/dates';
import { validateGstin } from '../validate/gstin';
import { classifyDocumentType } from './purchaseRegister';
import {
  autoMapFields,
  cellOf,
  detectHeaderRow,
  looksLikeTotalRow,
  readWorkbook,
  textOf,
  toSheetRows,
  type FieldSpec,
} from './csvExcel';
import { excerptOf, gstinIssueOf, previewOf, resolveDateColumn } from './common';

/**
 * IMS action log parser (optional input).
 *
 * This is the attribution layer, and it is the difference between a report that blames
 * suppliers and one that tells the truth. An invoice missing from GSTR-2B might be the
 * supplier's failure to file -- or it might be there and rejected by the buyer's own
 * staff, in which case the supplier did nothing wrong and the finding belongs to the
 * buyer's internal controls.
 *
 * Without this file every gap is `unattributed` and the interface says so plainly. The
 * engine treats IMS as an enhancement, never a dependency.
 */

export const IMS_LOG_FIELDS: FieldSpec[] = [
  {
    field: 'gstin',
    label: 'Supplier GSTIN',
    hint: 'Used to attach the action to a document.',
    required: true,
    synonyms: ['gstin', 'supplier gstin', 'gstin of supplier', 'gst no', 'gstin/uin'],
  },
  {
    field: 'invoiceNumber',
    label: 'Document number',
    hint: 'The document the action was taken on.',
    required: true,
    synonyms: [
      'invoice number',
      'invoice no',
      'document number',
      'doc no',
      'note number',
      'reference no',
    ],
  },
  {
    field: 'invoiceDate',
    label: 'Document date',
    hint: 'Used as the ageing start when no action date is present.',
    required: false,
    synonyms: ['invoice date', 'document date', 'doc date', 'date', 'note date'],
  },
  {
    field: 'value',
    label: 'Value',
    hint: 'Document value as shown in IMS.',
    required: false,
    synonyms: ['value', 'invoice value', 'total value', 'amount', 'document value'],
  },
  {
    field: 'action',
    label: 'Action',
    hint: 'Accept, Reject, Pending or No action.',
    required: true,
    synonyms: ['action', 'ims action', 'status', 'action taken', 'ims status'],
  },
  {
    field: 'actionDate',
    label: 'Date of action',
    hint: 'Starts the pending ageing clock.',
    required: false,
    synonyms: ['date of action', 'action date', 'actioned on', 'updated on', 'action taken on'],
  },
  {
    field: 'remark',
    label: 'Remark',
    hint: 'Shown against rejected credit notes, which need explaining.',
    required: false,
    synonyms: ['remark', 'remarks', 'reason', 'comment', 'notes', 'narration'],
  },
  {
    field: 'recordType',
    label: 'Record type',
    hint: 'Invoice, debit note or credit note.',
    required: false,
    synonyms: ['record type', 'document type', 'doc type', 'type', 'note type'],
  },
];

/**
 * Reads an IMS action cell.
 *
 * Anything unrecognised becomes `NoAction` rather than being dropped, because in IMS an
 * unrecognised or absent action has the same consequence as no action: the record is
 * deemed accepted when GSTR-3B is filed. Treating it as missing data would hide exactly
 * the control weakness the Findings screen exists to surface.
 */
export function parseImsAction(raw: string): ImsAction {
  const text = raw.trim().toLowerCase();
  if (/^acc?ept/.test(text) || text === 'a') return 'Accept';
  if (/^reject/.test(text) || text === 'r') return 'Reject';
  if (/^pend/.test(text) || text === 'p') return 'Pending';
  return 'NoAction';
}

export interface ImsParseOptions {
  dateFormatAnswers?: SlashDateFormatAnswers;
}

export function parseImsLog(file: InputFile, options: ImsParseOptions = {}): ParseOutcome<ImsLogRow> {
  const workbook = readWorkbook(file.content, file.fileName);
  const sheet = workbook.sheets[0] ?? { name: file.fileName, rows: [] };

  const detection = detectHeaderRow(sheet.rows, IMS_LOG_FIELDS);
  const fields = file.mapping?.fields ?? autoMapFields(detection.headers, IMS_LOG_FIELDS);
  const dataRows = toSheetRows(sheet.rows, detection.headerRowIndex, detection.headers);
  const period = file.period ?? '';

  const invoiceDateColumn = resolveDateColumn(
    'imsLog',
    file.fileName,
    fields,
    dataRows,
    'invoiceDate',
    'Document date',
    options.dateFormatAnswers,
  );
  const actionDateColumn = resolveDateColumn(
    'imsLog',
    file.fileName,
    fields,
    dataRows,
    'actionDate',
    'Date of action',
    options.dateFormatAnswers,
  );

  const rows: ImsLogRow[] = [];
  const gstinIssues: GstinIssue[] = [];
  const unparseableDates: UnparseableDate[] = [];
  const droppedRows: ParseOutcome<ImsLogRow>['droppedRows'] = [];

  for (const row of dataRows) {
    if (looksLikeTotalRow(row)) continue;

    const gstinRaw = textOf(row, fields, 'gstin');
    const gstin = validateGstin(gstinRaw);
    const invoiceNumber = textOf(row, fields, 'invoiceNumber');

    if (invoiceNumber === '' && gstin.normalized === null) {
      droppedRows.push({
        kind: 'imsLog',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        reason: 'No GSTIN or document number in the row.',
        excerpt: excerptOf(row.cells),
      });
      continue;
    }

    const issue = gstinIssueOf('imsLog', file.fileName, row.sourceRow, '', gstinRaw, gstin);
    if (issue) gstinIssues.push(issue);

    const invoiceDate = parseDateOnly(cellOf(row, fields, 'invoiceDate'), invoiceDateColumn.hint);
    if (invoiceDate.value === null && invoiceDate.problem !== 'blank') {
      unparseableDates.push({
        kind: 'imsLog',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        column: invoiceDateColumn.header ?? 'Document date',
        value: invoiceDate.raw,
      });
    }

    const actionDate = parseDateOnly(cellOf(row, fields, 'actionDate'), actionDateColumn.hint);

    rows.push({
      id: `ims:${period}:${String(row.sourceRow)}`,
      sourceRow: row.sourceRow,
      period,
      gstin: gstin.normalized,
      invoiceNumber,
      invoiceNumberNormalized: normalizeInvoiceNumber(invoiceNumber),
      invoiceDate: invoiceDate.value,
      value: parseMoneyOrZero(cellOf(row, fields, 'value')),
      action: parseImsAction(textOf(row, fields, 'action')),
      actionDate: actionDate.value,
      remark: textOf(row, fields, 'remark') || null,
      recordType: classifyDocumentType(textOf(row, fields, 'recordType')),
    });
  }

  const mapping: FileMapping = {
    kind: 'imsLog',
    fileName: file.fileName,
    headerRowIndex: detection.headerRowIndex,
    availableHeaders: detection.headers,
    fields,
    preview: previewOf(dataRows),
  };

  const ambiguous = [invoiceDateColumn.ambiguous, actionDateColumn.ambiguous].filter(
    (entry) => entry !== null,
  );

  return {
    rows,
    mapping,
    summary: {
      kind: 'imsLog',
      fileName: file.fileName,
      period: file.period,
      rowsRead: dataRows.length,
      rowsAccepted: rows.length,
      rowsDropped: droppedRows.length,
      headerRowIndex: detection.headerRowIndex,
    },
    gstinIssues,
    unparseableDates,
    ambiguousDateColumns: ambiguous,
    droppedRows,
  };
}

/**
 * Index of IMS actions for attribution lookup.
 *
 * Keyed on GSTIN plus normalised document number. The period is deliberately not part
 * of the key: a buyer often acts on a document in a later period than the one it was
 * reported in, and requiring the periods to agree would lose exactly those actions.
 */
export function indexImsLog(rows: readonly ImsLogRow[]): Map<string, ImsLogRow> {
  const index = new Map<string, ImsLogRow>();

  for (const row of rows) {
    const key = imsKey(row.gstin, row.invoiceNumberNormalized);
    const existing = index.get(key);

    // A later action supersedes an earlier one on the same document.
    if (!existing || (row.actionDate ?? '') > (existing.actionDate ?? '')) {
      index.set(key, row);
    }
  }

  return index;
}

export function imsKey(gstin: string | null, invoiceNumberNormalized: string): string {
  return `${gstin ?? ''}|${invoiceNumberNormalized}`;
}
