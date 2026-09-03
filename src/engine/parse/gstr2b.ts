import { normalizeInvoiceNumber } from '../normalize/invoiceNumber';
import { emptyTax, parseMoneyOrZero } from '../normalize/money';
import type {
  DocumentType,
  FileMapping,
  Gstr2bSection,
  GstinIssue,
  InputFile,
  ParseOutcome,
  Portal2bRow,
  SlashDateFormatAnswers,
  UnparseableDate,
} from '../types';
import { parseDateOnly } from '../validate/dates';
import { panKeyOf, validateGstin } from '../validate/gstin';
import {
  autoMapFields,
  cellOf,
  detectHeaderRow,
  looksLikeTotalRow,
  readWorkbook,
  textOf,
  toSheetRows,
  type FieldSpec,
  type SheetRow,
} from './csvExcel';
import { excerptOf, gstinIssueOf, previewOf, resolveDateColumn } from './common';

/**
 * GSTR-2B parser (Excel download from the GST portal).
 *
 * The portal workbook is one file with several sheets -- B2B, amendments, credit and
 * debit notes, their amendments, ISD and imports -- each with its own preamble rows and
 * its own column names for the same idea. Each sheet is read separately and tagged with
 * the section it came from, because the section determines how the row is treated:
 * an amendment supersedes an earlier document, and an ISD or import row is outside IMS
 * scope entirely.
 *
 * The field that makes this whole tool possible is the supplier's GSTR-1 filing date.
 * It is the only place, without an API or a subscription, where a buyer can see *when*
 * their supplier actually filed -- and therefore predict whether they will file on time
 * next month.
 */

export const GSTR2B_FIELDS: FieldSpec[] = [
  {
    field: 'supplierGstin',
    label: 'Supplier GSTIN',
    hint: 'GSTIN of the supplier who reported this document.',
    required: true,
    synonyms: [
      'gstin of supplier',
      'supplier gstin',
      'gstin',
      'gstin/uin of supplier',
      'gstin uin of supplier',
      'supplier gstin/uin',
    ],
  },
  {
    field: 'supplierName',
    label: 'Supplier name',
    hint: 'Trade or legal name as reported on the portal.',
    required: false,
    synonyms: [
      'trade/legal name',
      'trade legal name',
      'supplier name',
      'legal name',
      'trade name',
      'name',
    ],
  },
  {
    field: 'invoiceNumber',
    label: 'Document number',
    hint: 'Invoice or note number as the supplier reported it.',
    required: true,
    synonyms: [
      'invoice number',
      'invoice no',
      'note number',
      'note no',
      'document number',
      'doc no',
      'debit note number',
      'credit note number',
    ],
  },
  {
    field: 'invoiceDate',
    label: 'Document date',
    hint: 'Invoice or note date.',
    required: true,
    synonyms: [
      'invoice date',
      'note date',
      'document date',
      'inv date',
      'date',
      'note supply date',
    ],
  },
  {
    field: 'taxableValue',
    label: 'Taxable value',
    hint: 'Value before tax, as reported.',
    required: true,
    synonyms: ['taxable value', 'taxable value (₹)', 'taxable amount', 'taxable val'],
  },
  {
    field: 'igst',
    label: 'IGST',
    hint: 'Integrated tax.',
    required: false,
    synonyms: ['integrated tax', 'integrated tax(₹)', 'igst', 'igst(₹)', 'integrated tax (₹)'],
  },
  {
    field: 'cgst',
    label: 'CGST',
    hint: 'Central tax.',
    required: false,
    synonyms: ['central tax', 'central tax(₹)', 'cgst', 'cgst(₹)', 'central tax (₹)'],
  },
  {
    field: 'sgst',
    label: 'SGST',
    hint: 'State or UT tax.',
    required: false,
    synonyms: [
      'state/ut tax',
      'state ut tax',
      'state/ut tax(₹)',
      'sgst',
      'sgst(₹)',
      'state tax',
      'state/ut tax (₹)',
    ],
  },
  {
    field: 'cess',
    label: 'Cess',
    hint: 'Compensation cess.',
    required: false,
    synonyms: ['cess', 'cess(₹)', 'cess (₹)', 'compensation cess'],
  },
  {
    field: 'gstr1FilingDate',
    label: 'Supplier GSTR-1 filing date',
    hint: 'When the supplier actually filed. This is what makes delay measurable.',
    required: false,
    synonyms: [
      'gstr-1/iff/gstr-5 filing date',
      'gstr1/iff/gstr5 filing date',
      'gstr-1/5 filing date',
      'filing date',
      'gstr-1 filing date',
      'date of filing',
      'gstr1 filing date',
    ],
  },
  {
    field: 'gstr1Period',
    label: 'Supplier GSTR-1 period',
    hint: 'The return period the supplier reported this document in.',
    required: false,
    synonyms: [
      'gstr-1/iff/gstr-5 period',
      'gstr1/iff/gstr5 period',
      'gstr-1 period',
      'return period',
      'period',
      'tax period',
    ],
  },
  {
    field: 'itcAvailability',
    label: 'ITC availability',
    hint: 'Whether the portal says this credit is available.',
    required: false,
    synonyms: ['itc availability', 'itc available', 'availability of itc', 'itc avl'],
  },
  {
    field: 'itcUnavailableReason',
    label: 'Reason',
    hint: 'The portal reason when credit is not available.',
    required: false,
    synonyms: ['reason', 'reason for unavailability', 'itc unavailable reason', 'remarks'],
  },
  {
    field: 'reverseCharge',
    label: 'Reverse charge',
    hint: 'Reverse-charge documents are outside IMS scope.',
    required: false,
    synonyms: [
      'supply attract reverse charge',
      'reverse charge',
      'rev charge',
      'supply attracts reverse charge',
    ],
  },
  {
    field: 'docType',
    label: 'Note type',
    hint: 'On the credit/debit note sheets, which of the two this row is.',
    required: false,
    synonyms: ['note type', 'document type', 'note supply type', 'type', 'doc type'],
  },
  {
    field: 'originalInvoiceNumber',
    label: 'Original document number',
    hint: 'On an amendment sheet, the document being amended.',
    required: false,
    synonyms: [
      'original invoice number',
      'original note number',
      'original invoice no',
      'original document number',
      'original inv no',
    ],
  },
];

// ------------------------------------------------------------ business rules

/** Maps a portal sheet name onto the section it represents. */
export function classifySection(sheetName: string): Gstr2bSection {
  const name = sheetName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Amendment sheets must be tested before their base sheets: "b2ba" contains "b2b".
  if (name.includes('cdnra')) return 'cdnra';
  if (name.includes('b2ba')) return 'b2ba';
  if (name.includes('cdnr')) return 'cdnr';
  if (name.includes('impg')) return 'impg';
  if (name.includes('isd')) return 'isd';
  if (name.includes('b2b')) return 'b2b';
  return 'other';
}

/** Sections carrying documents this tool matches. Others are counted, not matched. */
export function isMatchableSection(section: Gstr2bSection): boolean {
  return section === 'b2b' || section === 'b2ba' || section === 'cdnr' || section === 'cdnra';
}

export function isAmendmentSection(section: Gstr2bSection): boolean {
  return section === 'b2ba' || section === 'cdnra';
}

/** Credit and debit notes arrive on the CDNR sheets; the note type is a column there. */
export function documentTypeForSection(section: Gstr2bSection, noteTypeText: string): DocumentType {
  if (section === 'cdnr' || section === 'cdnra') {
    return /debit/i.test(noteTypeText) ? 'debit_note' : 'credit_note';
  }
  return 'invoice';
}

/** Reads the portal's ITC availability column. Null when the column says nothing. */
export function parseItcAvailability(raw: string): boolean | null {
  const text = raw.trim().toLowerCase();
  if (text === '') return null;
  if (/^(y|yes|available|avl|true)$/.test(text)) return true;
  if (/^(n|no|not available|unavailable|false|na)$/.test(text)) return false;
  if (text.includes('not available') || text.includes('unavailable')) return false;
  if (text.includes('available')) return true;
  return null;
}

export function parseYesNo(raw: string): boolean {
  return /^(y|yes|true|1)$/i.test(raw.trim());
}

/**
 * Marks superseded documents.
 *
 * When an amendment refers to an earlier document, the earlier version no longer
 * represents what the supplier reported: matching against both would double-count the
 * credit. The latest amendment wins and every earlier version is linked to it.
 */
export function markSupersededRows(rows: Portal2bRow[]): void {
  const amendments = rows
    .filter((row) => row.isAmendment && row.amendsInvoiceNumberNormalized)
    .sort((a, b) => {
      // Latest first: by period, then by filing date, then by id for determinism.
      const byPeriod = b.period.localeCompare(a.period);
      if (byPeriod !== 0) return byPeriod;
      const byFiling = (b.gstr1FilingDate ?? '').localeCompare(a.gstr1FilingDate ?? '');
      if (byFiling !== 0) return byFiling;
      return b.id.localeCompare(a.id);
    });

  const latestByKey = new Map<string, Portal2bRow>();
  for (const amendment of amendments) {
    const key = `${amendment.supplierGstin ?? ''}|${amendment.amendsInvoiceNumberNormalized ?? ''}`;
    if (!latestByKey.has(key)) latestByKey.set(key, amendment);
  }

  for (const row of rows) {
    const key = `${row.supplierGstin ?? ''}|${row.invoiceNumberNormalized}`;
    const amendment = latestByKey.get(key);
    if (amendment && amendment.id !== row.id) {
      row.supersededById = amendment.id;
    }
  }

  // An amendment superseded by a later amendment of the same document.
  for (const amendment of amendments) {
    const key = `${amendment.supplierGstin ?? ''}|${amendment.amendsInvoiceNumberNormalized ?? ''}`;
    const latest = latestByKey.get(key);
    if (latest && latest.id !== amendment.id) {
      amendment.supersededById = latest.id;
    }
  }
}

// ----------------------------------------------------------------- the parser

export interface Gstr2bParseOptions {
  dateFormatAnswers?: SlashDateFormatAnswers;
}

function looksLikeJson(file: InputFile): boolean {
  if (file.fileName.toLowerCase().endsWith('.json')) return true;
  if (typeof file.content !== 'string') return false;
  return file.content.trimStart().startsWith('{');
}

export function parseGstr2b(
  file: InputFile,
  options: Gstr2bParseOptions = {},
): ParseOutcome<Portal2bRow> {
  const period = file.period ?? '';

  const emptyMapping: FileMapping = {
    kind: 'gstr2b',
    fileName: file.fileName,
    headerRowIndex: 0,
    availableHeaders: [],
    fields: [],
    preview: [],
  };

  /*
   * The JSON download is not implemented yet. It is reported as a named limitation
   * rather than parsed badly or ignored: a file that silently contributes no rows would
   * make every supplier in it look like they never filed anything.
   */
  if (looksLikeJson(file)) {
    return {
      rows: [],
      mapping: emptyMapping,
      summary: {
        kind: 'gstr2b',
        fileName: file.fileName,
        period: file.period,
        rowsRead: 0,
        rowsAccepted: 0,
        rowsDropped: 0,
        headerRowIndex: 0,
      },
      gstinIssues: [],
      unparseableDates: [],
      ambiguousDateColumns: [],
      droppedRows: [
        {
          kind: 'gstr2b',
          fileName: file.fileName,
          sourceRow: 0,
          reason:
            'GSTR-2B JSON is not supported yet. Download the Excel version of GSTR-2B from the ' +
            'portal and upload that instead. No rows from this file were used.',
          excerpt: file.fileName,
        },
      ],
      notImplemented: [
        `GSTR-2B JSON parsing (${file.fileName}). Use the Excel download from the portal.`,
      ],
    };
  }

  const workbook = readWorkbook(file.content, file.fileName);

  const rows: Portal2bRow[] = [];
  const gstinIssues: GstinIssue[] = [];
  const unparseableDates: UnparseableDate[] = [];
  const droppedRows: ParseOutcome<Portal2bRow>['droppedRows'] = [];
  const ambiguousDateColumns: ParseOutcome<Portal2bRow>['ambiguousDateColumns'] = [];
  const sections: Partial<Record<Gstr2bSection, number>> = {};

  let rowsRead = 0;
  let primaryMapping: FileMapping | null = null;

  for (const sheet of workbook.sheets) {
    const section = classifySection(sheet.name);
    const detection = detectHeaderRow(sheet.rows, GSTR2B_FIELDS);
    const fields =
      file.mapping && file.mapping.fields.length > 0
        ? file.mapping.fields
        : autoMapFields(detection.headers, GSTR2B_FIELDS);

    const dataRows = toSheetRows(sheet.rows, detection.headerRowIndex, detection.headers);
    if (dataRows.length === 0) continue;

    rowsRead += dataRows.length;
    sections[section] = (sections[section] ?? 0) + dataRows.length;

    const label = `${sheet.name} document date`;
    const invoiceDateColumn = resolveDateColumn(
      'gstr2b',
      file.fileName,
      fields,
      dataRows,
      'invoiceDate',
      label,
      options.dateFormatAnswers,
    );
    if (invoiceDateColumn.ambiguous) ambiguousDateColumns.push(invoiceDateColumn.ambiguous);

    const filingDateColumn = resolveDateColumn(
      'gstr2b',
      file.fileName,
      fields,
      dataRows,
      'gstr1FilingDate',
      `${sheet.name} filing date`,
      options.dateFormatAnswers,
    );
    if (filingDateColumn.ambiguous) ambiguousDateColumns.push(filingDateColumn.ambiguous);

    // Keep the first matchable sheet's mapping to show on the mapping screen.
    if (!primaryMapping && isMatchableSection(section)) {
      primaryMapping = {
        kind: 'gstr2b',
        fileName: `${file.fileName} — ${sheet.name}`,
        headerRowIndex: detection.headerRowIndex,
        availableHeaders: detection.headers,
        fields,
        preview: previewOf(dataRows),
      };
    }

    for (const row of dataRows) {
      if (looksLikeTotalRow(row)) {
        droppedRows.push({
          kind: 'gstr2b',
          fileName: file.fileName,
          sourceRow: row.sourceRow,
          reason: `Total line on sheet ${sheet.name}.`,
          excerpt: excerptOf(row.cells),
        });
        continue;
      }

      const gstinRaw = textOf(row, fields, 'supplierGstin');
      const gstin = validateGstin(gstinRaw);
      const supplierName = textOf(row, fields, 'supplierName');
      const invoiceNumber = textOf(row, fields, 'invoiceNumber');

      if (invoiceNumber === '' && gstin.normalized === null) {
        droppedRows.push({
          kind: 'gstr2b',
          fileName: file.fileName,
          sourceRow: row.sourceRow,
          reason: `No GSTIN or document number on sheet ${sheet.name}.`,
          excerpt: excerptOf(row.cells),
        });
        continue;
      }

      const issue = gstinIssueOf(
        'gstr2b',
        file.fileName,
        row.sourceRow,
        supplierName,
        gstinRaw,
        gstin,
      );
      if (issue) gstinIssues.push(issue);

      const invoiceDate = parseDateOnly(cellOf(row, fields, 'invoiceDate'), invoiceDateColumn.hint);
      if (invoiceDate.value === null && invoiceDate.problem !== 'blank') {
        unparseableDates.push({
          kind: 'gstr2b',
          fileName: file.fileName,
          sourceRow: row.sourceRow,
          column: invoiceDateColumn.header ?? label,
          value: invoiceDate.raw,
        });
      }

      const filingDate = parseDateOnly(
        cellOf(row, fields, 'gstr1FilingDate'),
        filingDateColumn.hint,
      );

      const noteTypeText = `${textOf(row, fields, 'docType')} ${sheet.name}`;
      const originalNumber = textOf(row, fields, 'originalInvoiceNumber');
      const isAmendment = isAmendmentSection(section);

      rows.push({
        id: `2b:${period}:${section}:${String(row.sourceRow)}`,
        sourceRow: row.sourceRow,
        sourceSection: section,
        period,
        supplierName,
        supplierGstin: gstin.normalized,
        panKey: panKeyOf(gstin.normalized),
        invoiceNumber,
        invoiceNumberNormalized: normalizeInvoiceNumber(invoiceNumber),
        invoiceDate: invoiceDate.value,
        docType: documentTypeForSection(section, noteTypeText),
        tax: {
          ...emptyTax(),
          taxable: parseMoneyOrZero(cellOf(row, fields, 'taxableValue')),
          cgst: parseMoneyOrZero(cellOf(row, fields, 'cgst')),
          sgst: parseMoneyOrZero(cellOf(row, fields, 'sgst')),
          igst: parseMoneyOrZero(cellOf(row, fields, 'igst')),
          cess: parseMoneyOrZero(cellOf(row, fields, 'cess')),
        },
        gstr1FilingDate: filingDate.value,
        itcAvailable: parseItcAvailability(textOf(row, fields, 'itcAvailability')),
        itcUnavailableReason: textOf(row, fields, 'itcUnavailableReason') || null,
        isAmendment,
        amendsInvoiceNumberNormalized: isAmendment
          ? normalizeInvoiceNumber(originalNumber) || null
          : null,
        supersededById: null,
        reverseCharge: parseYesNo(textOf(row, fields, 'reverseCharge')),
      });
    }
  }

  markSupersededRows(rows);

  return {
    rows,
    mapping: primaryMapping ?? emptyMapping,
    summary: {
      kind: 'gstr2b',
      fileName: file.fileName,
      period: file.period,
      rowsRead,
      rowsAccepted: rows.length,
      rowsDropped: droppedRows.length,
      headerRowIndex: primaryMapping?.headerRowIndex ?? 0,
      sections,
    },
    gstinIssues,
    unparseableDates,
    ambiguousDateColumns,
    droppedRows,
  };
}

/** Re-exported so callers can build a preview without importing csvExcel directly. */
export type { SheetRow };
