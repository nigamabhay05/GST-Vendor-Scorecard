import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { InputFile, Portal2bRow } from '../types';
import { buildDataHealthReport, findBookCollisions, findDuplicateInvoices } from '../validate/dataHealth';
import { autoMapFields, detectHeaderRow, looksLikeTotalRow, readWorkbook } from './csvExcel';
import {
  classifySection,
  isAmendmentSection,
  markSupersededRows,
  parseItcAvailability,
} from './gstr2b';
import { parseImsAction } from './imsLog';
import {
  PURCHASE_REGISTER_FIELDS,
  classifyDocumentType,
  classifyScope,
  parseItcEligibleFlag,
  parsePurchaseRegister,
} from './purchaseRegister';
import { parseFilingFrequency } from './supplierMaster';

/*
 * A purchase register the way one actually arrives: a company name and a date range
 * above the header, a blank row, amounts as text with a rupee sign, one blank GSTIN,
 * one GSTIN with a broken check digit, and a Grand Total line at the bottom.
 */
const MESSY_REGISTER_CSV = [
  'ABC Traders Private Limited,,,,,,,',
  'Purchase Register: 1 April 2026 to 30 April 2026,,,,,,,',
  ',,,,,,,',
  'Party Name,GSTIN,Invoice No,Invoice Date,Taxable Value,CGST,SGST,Doc Type',
  'Sharma Steel,27AAPFU0939F1ZV,INV/2026/001,25/04/2026,"₹1,44,000.00","₹12,960.00","₹12,960.00",Invoice',
  'Verma Cables,29AAGCB7383J1Z4,VC-88,26/04/2026,50000,4500,4500,Invoice',
  'Missing GSTIN Co,,MG/7,27/04/2026,10000,900,900,Invoice',
  'Bad Digit Ltd,27AAPFU0939F1ZW,BD/9,28/04/2026,20000,1800,1800,Invoice',
  'Cancelled Order,27AAPFU0939F1ZV,CN/3,29/04/2026,5000,450,450,Credit Note',
  'Grand Total,,,,229000,20610,20610,',
].join('\n');

function registerFile(content: string, fileName = 'register-apr.csv'): InputFile {
  return { kind: 'purchaseRegister', fileName, period: '2026-04', content };
}

describe('detectHeaderRow', () => {
  it('finds the header below a title block rather than assuming row 1', () => {
    const workbook = readWorkbook(MESSY_REGISTER_CSV, 'register.csv');
    const rows = workbook.sheets[0]?.rows ?? [];
    const detection = detectHeaderRow(rows, PURCHASE_REGISTER_FIELDS);

    // Zero-based: the header is the fourth line of the file.
    expect(detection.headerRowIndex).toBe(3);
    expect(detection.headers).toContain('Invoice No');
    expect(detection.hitRate).toBeGreaterThan(0.3);
  });

  it('falls back to the first non-empty row when nothing looks like a header', () => {
    const rows = [[], ['some', 'unrelated', 'text'], ['1', '2', '3']];
    const detection = detectHeaderRow(rows, PURCHASE_REGISTER_FIELDS);
    expect(detection.headerRowIndex).toBe(1);
    expect(detection.hitRate).toBe(0);
  });
});

describe('autoMapFields', () => {
  it('matches known header spellings exactly', () => {
    const mapping = autoMapFields(
      ['Party Name', 'GSTIN', 'Invoice No', 'Invoice Date', 'Taxable Value'],
      PURCHASE_REGISTER_FIELDS,
    );

    const byField = new Map(mapping.map((m) => [m.field, m]));
    expect(byField.get('supplierName')?.sourceHeader).toBe('Party Name');
    expect(byField.get('supplierName')?.confidence).toBe('exact');
    expect(byField.get('supplierGstin')?.sourceHeader).toBe('GSTIN');
    expect(byField.get('invoiceNumber')?.sourceHeader).toBe('Invoice No');
  });

  it('reports a field it could not find rather than guessing wildly', () => {
    const mapping = autoMapFields(['Column A', 'Column B'], PURCHASE_REGISTER_FIELDS);
    const gstin = mapping.find((m) => m.field === 'supplierGstin');
    expect(gstin?.confidence).toBe('none');
    expect(gstin?.sourceHeader).toBeNull();
  });

  it('never assigns one header to two fields', () => {
    const mapping = autoMapFields(
      ['Supplier Name', 'GSTIN', 'Invoice No', 'Invoice Date', 'Taxable Value', 'CGST', 'SGST'],
      PURCHASE_REGISTER_FIELDS,
    );

    const used = mapping.map((m) => m.sourceHeader).filter((h): h is string => h !== null);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('looksLikeTotalRow', () => {
  it('recognises a grand total line', () => {
    expect(
      looksLikeTotalRow({ sourceRow: 9, cells: { A: 'Grand Total', B: '', C: '229000' } }),
    ).toBe(true);
  });

  it('leaves a real document alone', () => {
    expect(
      looksLikeTotalRow({ sourceRow: 5, cells: { A: 'Sharma Steel', B: 'INV/1', C: '1000' } }),
    ).toBe(false);
  });
});

describe('parsePurchaseRegister', () => {
  const outcome = parsePurchaseRegister(registerFile(MESSY_REGISTER_CSV));

  it('reads every document and drops only the total line', () => {
    expect(outcome.rows).toHaveLength(5);
    expect(outcome.droppedRows).toHaveLength(1);
    expect(outcome.droppedRows[0]?.reason).toMatch(/total/i);
  });

  it('parses rupee amounts written as text with separators', () => {
    const sharma = outcome.rows.find((r) => r.supplierName === 'Sharma Steel');
    expect(sharma?.tax.taxable).toBe(144000);
    expect(sharma?.tax.cgst).toBe(12960);
    expect(sharma?.tax.sgst).toBe(12960);
  });

  it('resolves the date column from the one unambiguous value in it', () => {
    // Every date here is above the 12th, so DD/MM is proven and no prompt is needed.
    expect(outcome.ambiguousDateColumns).toHaveLength(0);
    expect(outcome.rows[0]?.invoiceDate).toBe('2026-04-25');
  });

  it('reports a blank GSTIN but keeps the row', () => {
    const blank = outcome.gstinIssues.find((i) => i.problem === 'blank');
    expect(blank?.supplierName).toBe('Missing GSTIN Co');
    expect(outcome.rows.some((r) => r.supplierName === 'Missing GSTIN Co')).toBe(true);
  });

  it('warns about a failed check digit without discarding the supplier', () => {
    const badDigit = outcome.gstinIssues.find((i) => i.problem === 'check_digit');
    expect(badDigit?.supplierName).toBe('Bad Digit Ltd');

    const row = outcome.rows.find((r) => r.supplierName === 'Bad Digit Ltd');
    expect(row?.supplierGstin).toBe('27AAPFU0939F1ZW');
    expect(row?.panKey).toBe('AAPFU0939F');
  });

  it('takes a credit note out of scope rather than matching it as an invoice', () => {
    const creditNote = outcome.rows.find((r) => r.invoiceNumber === 'CN/3');
    expect(creditNote?.docType).toBe('credit_note');
    expect(creditNote?.scope.inScope).toBe(false);
    expect(creditNote?.scope.reason).toBe('credit_note');
  });

  it('records where it decided the header was, so the user can correct it', () => {
    expect(outcome.mapping.headerRowIndex).toBe(3);
    expect(outcome.summary.rowsRead).toBe(6);
    expect(outcome.summary.rowsAccepted).toBe(5);
  });

  it('reads the same data out of a real Excel workbook', () => {
    // Proves the Excel path, including native date cells and numeric amounts.
    const sheet = XLSX.utils.aoa_to_sheet([
      ['ABC Traders Private Limited'],
      [],
      ['Supplier Name', 'GSTIN', 'Invoice No', 'Invoice Date', 'Taxable Value', 'IGST'],
      ['Sharma Steel', '27AAPFU0939F1ZV', 'INV/2026/001', new Date(Date.UTC(2026, 3, 25)), 144000, 25920],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
    const buffer = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const excel = parsePurchaseRegister({
      kind: 'purchaseRegister',
      fileName: 'register.xlsx',
      period: '2026-04',
      content: buffer,
    });

    expect(excel.rows).toHaveLength(1);
    expect(excel.rows[0]?.invoiceDate).toBe('2026-04-25');
    expect(excel.rows[0]?.tax.igst).toBe(25920);
    expect(excel.rows[0]?.invoiceNumberNormalized).toBe('INV20261');
  });

  it('raises a prompt when the date column proves nothing either way', () => {
    const ambiguous = [
      'Supplier Name,GSTIN,Invoice No,Invoice Date,Taxable Value',
      'Sharma Steel,27AAPFU0939F1ZV,INV/1,05/04/2026,1000',
      'Verma Cables,29AAGCB7383J1Z4,VC/2,06/07/2026,2000',
    ].join('\n');

    const result = parsePurchaseRegister(registerFile(ambiguous, 'ambiguous.csv'));

    expect(result.ambiguousDateColumns).toHaveLength(1);
    expect(result.ambiguousDateColumns[0]?.column).toBe('Invoice Date');
    expect(result.rows[0]?.invoiceDate).toBeNull();
  });

  it('uses the user answer once the ambiguous column has been resolved', () => {
    const ambiguous = [
      'Supplier Name,GSTIN,Invoice No,Invoice Date,Taxable Value',
      'Sharma Steel,27AAPFU0939F1ZV,INV/1,05/04/2026,1000',
    ].join('\n');

    const result = parsePurchaseRegister(registerFile(ambiguous, 'ambiguous.csv'), {
      dateFormatAnswers: { 'ambiguous.csv::Invoice Date': 'MDY' },
    });

    expect(result.ambiguousDateColumns).toHaveLength(0);
    expect(result.rows[0]?.invoiceDate).toBe('2026-05-04');
  });
});

describe('classifyScope', () => {
  const base = {
    docType: 'invoice' as const,
    itcEligibleFlag: null,
    natureOfSupply: '',
    docTypeText: '',
    supplierGstin: '27AAPFU0939F1ZV',
    supplierName: 'Sharma Steel',
    extraBlockedSuppliers: [] as string[],
  };

  it('keeps an ordinary invoice in scope', () => {
    expect(classifyScope(base).inScope).toBe(true);
  });

  it('excludes blocked credits, reverse charge, ISD, imports and POS-restricted supplies', () => {
    const cases: Array<[string, string]> = [
      ['Blocked u/s 17(5) - motor vehicle', 'blocked_17_5'],
      ['Reverse charge applicable', 'reverse_charge'],
      ['ISD invoice', 'isd'],
      ['Import of services', 'import_of_services'],
      ['POS restricted supply', 'pos_restricted'],
    ];

    for (const [nature, reason] of cases) {
      const result = classifyScope({ ...base, natureOfSupply: nature });
      expect(result.inScope).toBe(false);
      expect(result.reason).toBe(reason);
    }
  });

  it('honours the user-maintained blocked list by GSTIN and by name', () => {
    expect(
      classifyScope({ ...base, extraBlockedSuppliers: ['27AAPFU0939F1ZV'] }).reason,
    ).toBe('blocked_17_5');
    expect(classifyScope({ ...base, extraBlockedSuppliers: ['sharma steel'] }).reason).toBe(
      'blocked_17_5',
    );
  });

  it('excludes a document the register itself marks ineligible', () => {
    expect(classifyScope({ ...base, itcEligibleFlag: false }).reason).toBe('itc_ineligible_flag');
  });

  it('classifies a credit note as a credit note even when other markers are present', () => {
    const result = classifyScope({
      ...base,
      docType: 'credit_note',
      natureOfSupply: 'Reverse charge applicable',
    });
    expect(result.reason).toBe('credit_note');
  });
});

describe('small field readers', () => {
  it('classifies document types from the many ways they are written', () => {
    expect(classifyDocumentType('Credit Note')).toBe('credit_note');
    expect(classifyDocumentType('CN')).toBe('credit_note');
    expect(classifyDocumentType('Debit Note')).toBe('debit_note');
    expect(classifyDocumentType('Tax Invoice')).toBe('invoice');
    expect(classifyDocumentType('')).toBe('invoice');
  });

  it('reads ITC eligibility flags, returning null when the cell says nothing', () => {
    expect(parseItcEligibleFlag('Yes')).toBe(true);
    expect(parseItcEligibleFlag('N')).toBe(false);
    expect(parseItcEligibleFlag('Not eligible')).toBe(false);
    expect(parseItcEligibleFlag('')).toBeNull();
    expect(parseItcEligibleFlag('maybe')).toBeNull();
  });

  it('reads portal ITC availability', () => {
    expect(parseItcAvailability('Yes')).toBe(true);
    expect(parseItcAvailability('No')).toBe(false);
    expect(parseItcAvailability('')).toBeNull();
  });

  it('treats an unrecognised IMS action as no action, which is what it becomes', () => {
    expect(parseImsAction('Accepted')).toBe('Accept');
    expect(parseImsAction('Rejected')).toBe('Reject');
    expect(parseImsAction('Pending')).toBe('Pending');
    expect(parseImsAction('')).toBe('NoAction');
    expect(parseImsAction('something else')).toBe('NoAction');
  });

  it('reads filing frequency, returning null rather than guessing', () => {
    expect(parseFilingFrequency('Quarterly')).toBe('quarterly');
    expect(parseFilingFrequency('QRMP')).toBe('quarterly');
    expect(parseFilingFrequency('Monthly')).toBe('monthly');
    expect(parseFilingFrequency('')).toBeNull();
    expect(parseFilingFrequency('unknown')).toBeNull();
  });
});

describe('classifySection', () => {
  it('tests amendment sheets before their base sheets', () => {
    // "B2BA" contains "B2B"; getting this order wrong silently turns every amendment
    // into an ordinary invoice and double-counts the credit.
    expect(classifySection('B2BA')).toBe('b2ba');
    expect(classifySection('B2B')).toBe('b2b');
    expect(classifySection('B2B-CDNRA')).toBe('cdnra');
    expect(classifySection('B2B-CDNR')).toBe('cdnr');
    expect(classifySection('IMPG')).toBe('impg');
    expect(classifySection('ISD')).toBe('isd');
    expect(classifySection('Read me')).toBe('other');
  });

  it('knows which sections are amendments', () => {
    expect(isAmendmentSection('b2ba')).toBe(true);
    expect(isAmendmentSection('cdnra')).toBe(true);
    expect(isAmendmentSection('b2b')).toBe(false);
  });
});

describe('markSupersededRows', () => {
  function row(overrides: Partial<Portal2bRow> & Pick<Portal2bRow, 'id'>): Portal2bRow {
    return {
      sourceRow: 1,
      sourceSection: 'b2b',
      period: '2026-04',
      supplierName: 'Sharma Steel',
      supplierGstin: '27AAPFU0939F1ZV',
      panKey: 'AAPFU0939F',
      invoiceNumber: 'INV/1',
      invoiceNumberNormalized: 'INV1',
      invoiceDate: '2026-04-05',
      docType: 'invoice',
      tax: { taxable: 1000, cgst: 90, sgst: 90, igst: 0, cess: 0 },
      gstr1FilingDate: '2026-05-10',
      itcAvailable: true,
      itcUnavailableReason: null,
      isAmendment: false,
      amendsInvoiceNumberNormalized: null,
      supersededById: null,
      reverseCharge: false,
      ...overrides,
    };
  }

  it('marks an original as superseded by its amendment', () => {
    const original = row({ id: 'a' });
    const amendment = row({
      id: 'b',
      sourceSection: 'b2ba',
      period: '2026-05',
      isAmendment: true,
      amendsInvoiceNumberNormalized: 'INV1',
    });

    const rows = [original, amendment];
    markSupersededRows(rows);

    expect(original.supersededById).toBe('b');
    expect(amendment.supersededById).toBeNull();
  });

  it('keeps only the latest of two amendments to the same document', () => {
    const original = row({ id: 'a' });
    const first = row({
      id: 'b',
      sourceSection: 'b2ba',
      period: '2026-05',
      isAmendment: true,
      amendsInvoiceNumberNormalized: 'INV1',
    });
    const second = row({
      id: 'c',
      sourceSection: 'b2ba',
      period: '2026-06',
      isAmendment: true,
      amendsInvoiceNumberNormalized: 'INV1',
    });

    const rows = [original, first, second];
    markSupersededRows(rows);

    expect(second.supersededById).toBeNull();
    expect(first.supersededById).toBe('c');
    expect(original.supersededById).toBe('c');
  });

  it('leaves a different supplier alone', () => {
    const mine = row({ id: 'a' });
    const theirs = row({ id: 'b', supplierGstin: '29AAGCB7383J1Z4' });
    const amendment = row({
      id: 'c',
      supplierGstin: '29AAGCB7383J1Z4',
      isAmendment: true,
      sourceSection: 'b2ba',
      amendsInvoiceNumberNormalized: 'INV1',
    });

    markSupersededRows([mine, theirs, amendment]);

    expect(mine.supersededById).toBeNull();
    expect(theirs.supersededById).toBe('c');
  });
});

describe('data health aggregation', () => {
  const collisionCsv = [
    'Supplier Name,GSTIN,Invoice No,Invoice Date,Taxable Value',
    'Sharma Steel,27AAPFU0939F1ZV,A/1,25/04/2026,1000',
    'Sharma Steel,27AAPFU0939F1ZV,A-01,26/04/2026,2000',
    'Verma Cables,29AAGCB7383J1Z4,VC/7,27/04/2026,3000',
    'Verma Cables,29AAGCB7383J1Z4,VC/7,28/04/2026,3000',
  ].join('\n');

  const outcome = parsePurchaseRegister(registerFile(collisionCsv, 'collisions.csv'));

  it('flags a normalisation collision without merging the two documents', () => {
    const collisions = findBookCollisions(outcome.rows);

    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.normalizedKey).toBe('A1');
    expect(collisions[0]?.originalInvoiceNumbers).toEqual(['A/1', 'A-01']);

    // Both survive as separate rows. Merging would halve the recorded purchases.
    expect(outcome.rows.filter((r) => r.supplierName === 'Sharma Steel')).toHaveLength(2);
  });

  it('reports a repeated invoice number as a duplicate, not a collision', () => {
    const duplicates = findDuplicateInvoices(outcome.rows);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.invoiceNumber).toBe('VC/7');
    expect(duplicates[0]?.identicalValues).toBe(true);
    expect(findBookCollisions(outcome.rows).some((c) => c.normalizedKey === 'VC7')).toBe(false);
  });

  it('blocks the report only while an ambiguous date column is unanswered', () => {
    const clean = buildDataHealthReport({ outcomes: [outcome], bookRows: outcome.rows });
    expect(clean.blocking).toBe(false);

    const ambiguous = parsePurchaseRegister(
      registerFile(
        [
          'Supplier Name,GSTIN,Invoice No,Invoice Date,Taxable Value',
          'Sharma Steel,27AAPFU0939F1ZV,INV/1,05/04/2026,1000',
        ].join('\n'),
        'ambiguous.csv',
      ),
    );
    const blocked = buildDataHealthReport({
      outcomes: [ambiguous],
      bookRows: ambiguous.rows,
    });
    expect(blocked.blocking).toBe(true);
  });

  it('totals scope exclusions by reason', () => {
    const withCreditNote = parsePurchaseRegister(registerFile(MESSY_REGISTER_CSV));
    const report = buildDataHealthReport({
      outcomes: [withCreditNote],
      bookRows: withCreditNote.rows,
    });

    const creditNotes = report.scopeExclusions.find((s) => s.reason === 'credit_note');
    expect(creditNotes?.rows).toBe(1);
    expect(creditNotes?.taxValue).toBe(900);
  });
});
