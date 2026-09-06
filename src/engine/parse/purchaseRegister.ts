import { SCOPE } from '../config';
import { normalizeInvoiceNumber } from '../normalize/invoiceNumber';
import { emptyTax, parseMoney, parseMoneyOrZero } from '../normalize/money';
import type {
  BookRow,
  DocumentType,
  FileMapping,
  GstinIssue,
  InputFile,
  ParseOutcome,
  ScopeClassification,
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
} from './csvExcel';
import { excerptOf, gstinIssueOf, previewOf, resolveDateColumn } from './common';

/**
 * Purchase register parser.
 *
 * The register is the buyer's own record of what they bought, and it is the side of the
 * comparison that a real user can actually correct. Everything here is therefore
 * forgiving: a row with a broken GSTIN or an unreadable date is kept, flagged, and
 * carried into matching, because dropping it would understate the buyer's purchases and
 * quietly improve every supplier's score.
 */

export const PURCHASE_REGISTER_FIELDS: FieldSpec[] = [
  {
    field: 'supplierName',
    label: 'Supplier name',
    hint: 'Used to group documents when a GSTIN is missing.',
    required: true,
    synonyms: [
      'supplier name',
      'supplier',
      'party name',
      'party',
      'vendor name',
      'vendor',
      'particulars',
      'name of supplier',
      'ledger name',
    ],
  },
  {
    field: 'supplierGstin',
    label: 'Supplier GSTIN',
    hint: 'The key every match tier relies on.',
    required: true,
    synonyms: [
      'supplier gstin',
      'gstin',
      'gst no',
      'gstin no',
      'gstin of supplier',
      'party gstin',
      'vendor gstin',
      'gstin/uin',
      'gstin uin',
      'gst number',
    ],
  },
  {
    field: 'invoiceNumber',
    label: 'Invoice number',
    hint: 'Normalised before matching, so INV/2026/001 and INV-2026-1 agree.',
    required: true,
    synonyms: [
      'invoice number',
      'invoice no',
      'inv no',
      'bill no',
      'document number',
      'doc no',
      'invoice',
      'supplier invoice no',
    ],
    // A register's own numbering, not the supplier's. Used only when nothing better
    // exists, and always flagged, because GSTR-2B carries the supplier's number.
    fallbackSynonyms: ['reference no', 'voucher no'],
  },
  {
    field: 'invoiceDate',
    label: 'Invoice date',
    hint: 'Decides which GSTR-2B period the credit should appear in.',
    required: true,
    synonyms: [
      'invoice date',
      'inv date',
      'bill date',
      'document date',
      'doc date',
    ],
    // 'Date' alone is often the booking date rather than the document date.
    fallbackSynonyms: ['date', 'voucher date'],
  },
  {
    field: 'taxableValue',
    label: 'Taxable value',
    hint: 'Value before tax. Used by match tier 3.',
    required: true,
    synonyms: [
      'taxable value',
      'taxable amount',
      'assessable value',
      'net amount',
      'basic amount',
      'value',
      'taxable',
    ],
  },
  {
    field: 'cgst',
    label: 'CGST',
    hint: 'Central GST. Blank for inter-state supplies.',
    required: false,
    synonyms: ['cgst', 'cgst amount', 'central tax', 'cgst amt', 'central gst'],
  },
  {
    field: 'sgst',
    label: 'SGST',
    hint: 'State GST. Blank for inter-state supplies.',
    required: false,
    synonyms: ['sgst', 'sgst amount', 'state tax', 'sgst amt', 'state gst', 'sgst/utgst', 'utgst'],
  },
  {
    field: 'igst',
    label: 'IGST',
    hint: 'Integrated GST. Blank for intra-state supplies.',
    required: false,
    synonyms: ['igst', 'igst amount', 'integrated tax', 'igst amt', 'integrated gst'],
  },
  {
    field: 'cess',
    label: 'Cess',
    hint: 'Compensation cess, if any.',
    required: false,
    synonyms: ['cess', 'cess amount', 'compensation cess', 'cess amt'],
  },
  {
    field: 'docType',
    label: 'Document type',
    hint: 'Invoice, debit note or credit note. Credit notes are never matched as invoices.',
    required: false,
    synonyms: [
      'document type',
      'doc type',
      'type',
      'voucher type',
      'nature of document',
      'document category',
    ],
  },
  {
    field: 'itcEligible',
    label: 'ITC eligible',
    hint: 'Optional flag from the register. Ineligible credit is excluded from at-risk.',
    required: false,
    synonyms: [
      'itc eligible',
      'eligibility',
      'itc eligibility',
      'eligible for itc',
      'itc availability',
      'eligible',
    ],
  },
  {
    field: 'natureOfSupply',
    label: 'Nature of supply / remarks',
    hint: 'Scanned for reverse charge, ISD, imports and blocked credits.',
    required: false,
    synonyms: [
      'nature of supply',
      'remarks',
      'narration',
      'supply type',
      'category',
      'notes',
      'description',
      'reason',
    ],
  },
];

// ------------------------------------------------------------ business rules

/** Reads a document-type cell the way any of the common exports write it. */
export function classifyDocumentType(raw: string): DocumentType {
  const text = raw.toLowerCase().trim();
  if (text === '') return 'invoice';

  if (/credit\s*note|\bcr\.?\s*note\b|^cn$|\bcdnr\b/.test(text)) return 'credit_note';
  if (/debit\s*note|\bdr\.?\s*note\b|^dn$/.test(text)) return 'debit_note';
  return 'invoice';
}

/** True when any of the configured markers appears in the text. */
function hasMarker(text: string, markers: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return markers.some((marker) => haystack.includes(marker.toLowerCase()));
}

/**
 * Reads an "ITC eligible" cell. Returns null when the column is absent or says nothing
 * legible, which is different from saying "no".
 */
export function parseItcEligibleFlag(raw: string): boolean | null {
  const text = raw.toLowerCase().trim();
  if (text === '') return null;

  if (/^(y|yes|true|1|eligible|available|avl)$/.test(text)) return true;
  if (/^(n|no|false|0|ineligible|not eligible|blocked|unavailable|na)$/.test(text)) return false;

  // Longer prose: fall back to looking for a negation.
  if (/\bnot eligible\b|\bineligible\b|\bblocked\b/.test(text)) return false;
  if (/\beligible\b|\bavailable\b/.test(text)) return true;

  return null;
}

/**
 * Decides whether a document counts towards ITC at risk and towards supplier scoring.
 *
 * Excluded documents are counted and displayed separately rather than deleted. Scoring
 * a supplier down over credit that nobody was ever entitled to claim -- a blocked
 * 17(5) purchase, a reverse-charge document the buyer pays tax on themselves -- is the
 * single commonest way a tool like this loses the confidence of the person using it.
 *
 * Order matters: a credit note is classified as a credit note even when it also carries
 * a reverse-charge marker, because the credit note handling is the more specific rule.
 */
export function classifyScope(input: {
  docType: DocumentType;
  itcEligibleFlag: boolean | null;
  natureOfSupply: string;
  docTypeText: string;
  supplierGstin: string | null;
  supplierName: string;
  extraBlockedSuppliers: readonly string[];
}): ScopeClassification {
  if (input.docType === 'credit_note') {
    return { inScope: false, reason: 'credit_note' };
  }

  const haystack = `${input.natureOfSupply} ${input.docTypeText}`;

  // A user-maintained blocked list, matched on GSTIN or on supplier name.
  const blockedList = input.extraBlockedSuppliers.map((entry) => entry.trim().toLowerCase());
  const gstinLower = input.supplierGstin?.toLowerCase() ?? null;
  const nameLower = input.supplierName.trim().toLowerCase();
  if (
    blockedList.length > 0 &&
    ((gstinLower !== null && blockedList.includes(gstinLower)) ||
      (nameLower !== '' && blockedList.includes(nameLower)))
  ) {
    return { inScope: false, reason: 'blocked_17_5' };
  }

  if (hasMarker(haystack, SCOPE.blocked17_5Markers)) {
    return { inScope: false, reason: 'blocked_17_5' };
  }
  if (hasMarker(haystack, SCOPE.reverseChargeMarkers)) {
    return { inScope: false, reason: 'reverse_charge' };
  }
  if (hasMarker(haystack, SCOPE.isdMarkers)) {
    return { inScope: false, reason: 'isd' };
  }
  if (hasMarker(haystack, SCOPE.importOfServicesMarkers)) {
    return { inScope: false, reason: 'import_of_services' };
  }
  if (hasMarker(haystack, SCOPE.posRestrictedMarkers)) {
    return { inScope: false, reason: 'pos_restricted' };
  }

  if (input.itcEligibleFlag === false) {
    return { inScope: false, reason: 'itc_ineligible_flag' };
  }

  return { inScope: true, reason: null };
}

// ----------------------------------------------------------------- the parser

export interface ParseOptions {
  dateFormatAnswers?: SlashDateFormatAnswers;
  extraBlockedSuppliers?: readonly string[];
}

export function parsePurchaseRegister(
  file: InputFile,
  options: ParseOptions = {},
): ParseOutcome<BookRow> {
  const workbook = readWorkbook(file.content, file.fileName);
  const sheet = workbook.sheets[0] ?? { name: file.fileName, rows: [] };

  const detection = detectHeaderRow(sheet.rows, PURCHASE_REGISTER_FIELDS);
  const fields =
    file.mapping?.fields ?? autoMapFields(detection.headers, PURCHASE_REGISTER_FIELDS);

  const dataRows = toSheetRows(sheet.rows, detection.headerRowIndex, detection.headers);
  const period = file.period ?? '';

  // Date format is settled once for the whole column before any row is read, so one
  // unambiguous value anywhere in the file settles every ambiguous value in it.
  const dateColumn = resolveDateColumn(
    'purchaseRegister',
    file.fileName,
    fields,
    dataRows,
    'invoiceDate',
    'Invoice date',
    options.dateFormatAnswers,
  );

  const rows: BookRow[] = [];
  const gstinIssues: GstinIssue[] = [];
  const unparseableDates: UnparseableDate[] = [];
  const droppedRows: ParseOutcome<BookRow>['droppedRows'] = [];

  for (const row of dataRows) {
    if (looksLikeTotalRow(row)) {
      droppedRows.push({
        kind: 'purchaseRegister',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        reason: 'Looks like a total or subtotal line rather than a document.',
        excerpt: excerptOf(row.cells),
      });
      continue;
    }

    const supplierName = textOf(row, fields, 'supplierName');
    const invoiceNumber = textOf(row, fields, 'invoiceNumber');
    const gstinRaw = textOf(row, fields, 'supplierGstin');
    const gstin = validateGstin(gstinRaw);

    // A row with neither an invoice number nor a supplier is not a document at all.
    if (invoiceNumber === '' && supplierName === '' && gstin.normalized === null) {
      droppedRows.push({
        kind: 'purchaseRegister',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        reason: 'No supplier, GSTIN or invoice number in the row.',
        excerpt: excerptOf(row.cells),
      });
      continue;
    }

    // A blank, malformed or check-digit-failing GSTIN is reported and kept, never
    // dropped. See validate/gstin.ts for why.
    const issue = gstinIssueOf(
      'purchaseRegister',
      file.fileName,
      row.sourceRow,
      supplierName,
      gstinRaw,
      gstin,
    );
    if (issue) gstinIssues.push(issue);

    const parsedDate = parseDateOnly(cellOf(row, fields, 'invoiceDate'), dateColumn.hint);
    if (parsedDate.value === null && parsedDate.problem !== 'blank') {
      unparseableDates.push({
        kind: 'purchaseRegister',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        column: dateColumn.header ?? 'Invoice date',
        value: parsedDate.raw,
      });
    }

    const docTypeText = textOf(row, fields, 'docType');
    const docType = classifyDocumentType(docTypeText);
    const natureOfSupply = textOf(row, fields, 'natureOfSupply');
    const itcEligibleFlag = parseItcEligibleFlag(textOf(row, fields, 'itcEligible'));

    const tax = {
      ...emptyTax(),
      taxable: parseMoneyOrZero(cellOf(row, fields, 'taxableValue')),
      cgst: parseMoneyOrZero(cellOf(row, fields, 'cgst')),
      sgst: parseMoneyOrZero(cellOf(row, fields, 'sgst')),
      igst: parseMoneyOrZero(cellOf(row, fields, 'igst')),
      cess: parseMoneyOrZero(cellOf(row, fields, 'cess')),
    };

    // A credit note booked as a positive amount is still a reduction. Sign is carried
    // by the document type, so amounts are stored as their absolute magnitude and the
    // credit note handling in analyse/ applies the direction.
    const taxableParse = parseMoney(cellOf(row, fields, 'taxableValue'));
    if (taxableParse.problem === 'unparseable') {
      droppedRows.push({
        kind: 'purchaseRegister',
        fileName: file.fileName,
        sourceRow: row.sourceRow,
        reason: `Taxable value could not be read: "${taxableParse.raw}".`,
        excerpt: excerptOf(row.cells),
      });
      continue;
    }

    rows.push({
      id: `book:${period}:${String(row.sourceRow)}`,
      sourceRow: row.sourceRow,
      period,
      supplierName,
      supplierGstin: gstin.normalized,
      panKey: panKeyOf(gstin.normalized),
      invoiceNumber,
      invoiceNumberNormalized: normalizeInvoiceNumber(invoiceNumber),
      invoiceDate: parsedDate.value,
      docType,
      tax,
      itcEligibleFlag,
      scope: classifyScope({
        docType,
        itcEligibleFlag,
        natureOfSupply,
        docTypeText,
        supplierGstin: gstin.normalized,
        supplierName,
        extraBlockedSuppliers: options.extraBlockedSuppliers ?? [],
      }),
    });
  }

  const mapping: FileMapping = {
    kind: 'purchaseRegister',
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
      kind: 'purchaseRegister',
      fileName: file.fileName,
      period: file.period,
      rowsRead: dataRows.length,
      rowsAccepted: rows.length,
      rowsDropped: droppedRows.length,
      headerRowIndex: detection.headerRowIndex,
    },
    gstinIssues,
    unparseableDates,
    ambiguousDateColumns: dateColumn.ambiguous ? [dateColumn.ambiguous] : [],
    droppedRows,
  };
}

