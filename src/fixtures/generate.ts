 
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { computeGstinCheckCharacter } from '../engine/validate/gstin';
import { addMonths, periodFromDate } from '../engine/normalize/period';

/**
 * Synthetic sample data generator.
 *
 * Deterministic: one fixed seed, so the committed files and every headline figure in the
 * demo are reproducible. The dataset exists to show the things only this tool surfaces,
 * so every awkward case in it is deliberate -- a chronic late filer, a supplier who
 * looks guilty until the IMS log clears them, a QRMP filer who must score green, credit
 * quietly ageing towards its expiry date.
 *
 * Run with `npm run fixtures`.
 */

const SEED = 20260401;

/** The dataset's fixed reference date. Pinned so the demo's figures never drift. */
export const SAMPLE_AS_OF = '2026-10-05';

/** Eight monthly periods spanning two financial years. */
export const SAMPLE_PERIODS = [
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
];

export const BUYER_GSTIN = '27AAACB2894G1ZP';

// ------------------------------------------------------------------- random

/** mulberry32: small, fast, and identical across runs and platforms. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(SEED);

function randomInt(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

// -------------------------------------------------------------------- gstin

/** Builds a structurally valid GSTIN, check character and all. */
function makeGstin(stateCode: string, pan: string, entity = '1'): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  const check = computeGstinCheckCharacter(first14);
  if (!check) throw new Error(`Could not build a GSTIN for ${pan}`);
  return `${first14}${check}`;
}

// ---------------------------------------------------------------- suppliers

type Behaviour =
  | 'clean'
  | 'chronic_late'
  | 'buyer_rejected'
  | 'quarterly'
  | 'wrong_buyer_gstin'
  | 'march_collapse'
  | 'number_drift'
  | 'forgotten_pending'
  | 'rejected_credit_note'
  | 'blocked_17_5'
  | 'pan_state_mismatch'
  | 'new_supplier';

interface SupplierSpec {
  code: string;
  name: string;
  stateCode: string;
  pan: string;
  behaviour: Behaviour;
  invoicesPerPeriod: number;
  baseTaxable: number;
  interState: boolean;
  contact: { person: string; email: string; phone: string; terms: number };
  /** Indices into SAMPLE_PERIODS. Defaults to all of them. */
  activePeriods?: number[];
}

function contact(person: string, domain: string, phone: string, terms = 30) {
  return { person, email: `${person.split(' ')[0]?.toLowerCase() ?? 'accounts'}@${domain}`, phone, terms };
}

/*
 * Twenty-five suppliers. The first eleven carry the seeded patterns the demo exists to
 * show; the rest are ordinary trade creditors so the scorecard looks like a real one
 * rather than a list of disasters.
 */
const SUPPLIERS: SupplierSpec[] = [
  {
    code: 'S01',
    name: 'Mahesh Steel Traders',
    stateCode: '27',
    pan: 'AAPFM4821K',
    behaviour: 'chronic_late',
    invoicesPerPeriod: 3,
    baseTaxable: 480000,
    interState: false,
    contact: contact('Mahesh Kulkarni', 'maheshsteel.example', '+91 98200 11223', 45),
  },
  {
    code: 'S02',
    name: 'Precision Components Pvt Ltd',
    stateCode: '29',
    pan: 'AADCP7712H',
    behaviour: 'buyer_rejected',
    invoicesPerPeriod: 2,
    baseTaxable: 265000,
    interState: true,
    contact: contact('Latha Rao', 'precisioncomp.example', '+91 80456 77120', 30),
  },
  {
    code: 'S03',
    name: 'Kaveri Packaging',
    stateCode: '29',
    pan: 'AAKFK3390B',
    behaviour: 'quarterly',
    invoicesPerPeriod: 2,
    baseTaxable: 118000,
    interState: true,
    contact: contact('Girish Shetty', 'kaveripack.example', '+91 80223 90881', 30),
  },
  {
    code: 'S04',
    name: 'Deccan Freight Carriers',
    stateCode: '36',
    pan: 'AAECD5567L',
    behaviour: 'wrong_buyer_gstin',
    invoicesPerPeriod: 2,
    baseTaxable: 96000,
    interState: true,
    contact: contact('Ramesh Naidu', 'deccanfreight.example', '+91 40667 20114', 15),
  },
  {
    code: 'S05',
    name: 'Anand Polymers',
    stateCode: '24',
    pan: 'AAGCA1188M',
    behaviour: 'march_collapse',
    invoicesPerPeriod: 3,
    baseTaxable: 310000,
    interState: true,
    contact: contact('Anand Desai', 'anandpolymers.example', '+91 79220 34567', 60),
  },
  {
    code: 'S06',
    name: 'Surya Electricals',
    stateCode: '27',
    pan: 'AABFS9034J',
    behaviour: 'number_drift',
    invoicesPerPeriod: 2,
    baseTaxable: 143000,
    interState: false,
    contact: contact('Suryakant Patil', 'suryaelec.example', '+91 98670 45512', 30),
  },
  {
    code: 'S07',
    name: 'Nilkanth Traders',
    stateCode: '27',
    pan: 'AAJFN2276C',
    behaviour: 'forgotten_pending',
    invoicesPerPeriod: 2,
    baseTaxable: 205000,
    interState: false,
    contact: contact('Nilesh Kanth', 'nilkanth.example', '+91 98191 33440', 30),
  },
  {
    code: 'S08',
    name: 'Ratna Chemicals',
    stateCode: '24',
    pan: 'AAECR8890P',
    behaviour: 'rejected_credit_note',
    invoicesPerPeriod: 2,
    baseTaxable: 178000,
    interState: true,
    contact: contact('Ratna Iyer', 'ratnachem.example', '+91 79556 21008', 45),
  },
  {
    code: 'S09',
    name: 'Metro Motors',
    stateCode: '27',
    pan: 'AAACM6543N',
    behaviour: 'blocked_17_5',
    invoicesPerPeriod: 1,
    baseTaxable: 890000,
    interState: false,
    contact: contact('Farhan Shaikh', 'metromotors.example', '+91 22661 77000', 0),
  },
  {
    code: 'S10',
    name: 'Vindhya Alloys',
    stateCode: '23',
    pan: 'AAFCV4412Q',
    behaviour: 'pan_state_mismatch',
    invoicesPerPeriod: 2,
    baseTaxable: 262000,
    interState: true,
    contact: contact('Vikram Jain', 'vindhyaalloys.example', '+91 75512 88090', 30),
  },
  {
    code: 'S11',
    name: 'Sahyadri Logistics',
    stateCode: '27',
    pan: 'AAHFS1129D',
    behaviour: 'new_supplier',
    invoicesPerPeriod: 2,
    baseTaxable: 87000,
    interState: false,
    contact: contact('Prasad Joshi', 'sahyadrilog.example', '+91 20445 66123', 30),
    // Only the last two periods: not enough history to score.
    activePeriods: [6, 7],
  },
];

const ORDINARY_NAMES: Array<[string, string, string, boolean]> = [
  ['Bharat Office Supplies', '27', 'AAFCB2210G', false],
  ['Konkan Hardware', '27', 'AAGFK5561R', false],
  ['Trident Paper Mills', '24', 'AAACT3398E', true],
  ['Lakshmi Fasteners', '33', 'AAJFL7745T', true],
  ['Orion Software Services', '29', 'AAECO9912W', true],
  ['Ganga Textiles', '09', 'AAHFG4423Y', true],
  ['Pinnacle Safety Gear', '27', 'AAKFP6678U', false],
  ['Sundar Printing Works', '33', 'AABFS2234V', true],
  ['Ashoka Civil Works', '27', 'AAFCA8801X', false],
  ['Nova Instruments', '29', 'AADCN3345Z', true],
  ['Meridian Housekeeping', '27', 'AAGFM1167A', false],
  ['Coral Adhesives', '24', 'AAECC7789B', true],
  ['Yamuna Agro Products', '09', 'AAJFY5523C', true],
  ['Zenith Tooling', '27', 'AABCZ9934D', false],
];

for (const [index, [name, stateCode, pan, interState]] of ORDINARY_NAMES.entries()) {
  const first = name.split(' ')[0] ?? 'Accounts';
  SUPPLIERS.push({
    code: `S${String(index + 12).padStart(2, '0')}`,
    name,
    stateCode,
    pan,
    behaviour: 'clean',
    invoicesPerPeriod: randomInt(1, 3),
    baseTaxable: randomInt(35, 190) * 1000,
    interState,
    contact: contact(`${first} Desk`, `${first.toLowerCase()}.example`, '+91 90000 00000', 30),
  });
}

// ------------------------------------------------------------------ records

interface BookRecord {
  supplier: SupplierSpec;
  gstinInRegister: string;
  invoiceNumber: string;
  invoiceDate: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  docType: string;
  natureOfSupply: string;
  itcEligible: string;
  period: string;
}

interface PortalRecord {
  section: 'b2b' | 'cdnr' | 'b2ba';
  supplier: SupplierSpec;
  gstin: string;
  invoiceNumber: string;
  invoiceDate: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  filingDate: string;
  itcAvailable: string;
  reverseCharge: string;
  noteType?: string;
  originalNumber?: string;
  period: string;
}

interface ImsRecord {
  gstin: string;
  invoiceNumber: string;
  invoiceDate: string;
  value: number;
  action: 'Accept' | 'Reject' | 'Pending' | 'NoAction';
  actionDate: string;
  remark: string;
  recordType: string;
  period: string;
}

const bookRecords: BookRecord[] = [];
const portalRecords: PortalRecord[] = [];
const imsRecords: ImsRecord[] = [];

function taxFor(spec: SupplierSpec, taxable: number) {
  const rate = 0.18;
  if (spec.interState) {
    return { cgst: 0, sgst: 0, igst: Math.round(taxable * rate) };
  }
  const half = Math.round((taxable * rate) / 2);
  return { cgst: half, sgst: half, igst: 0 };
}

function dayInPeriod(period: string, day: number): string {
  return `${period}-${String(day).padStart(2, '0')}`;
}

/**
 * A filing date in the month after the period. GSTR-1 is due on the 11th, so filers
 * cluster around it and late ones fall after.
 *
 * The day is spread across a range that reliably includes values above 12. That is not
 * cosmetic: a column in which every day is 12 or less is genuinely indistinguishable
 * from MM/DD, and the engine would correctly refuse to read it -- which would stop the
 * one-click demo dead at the Data Health prompt.
 */
function filingDateFor(period: string, monthsLate: number, dayOffset = 0): string {
  const target = addMonths(period, 1 + monthsLate) ?? period;
  return dayInPeriod(target, Math.min(28, 8 + dayOffset + randomInt(0, 8)));
}

function pushIms(record: ImsRecord) {
  imsRecords.push(record);
}

function generate() {
  for (const spec of SUPPLIERS) {
    const gstin = makeGstin(spec.stateCode, spec.pan);
    const activeIndices = spec.activePeriods ?? SAMPLE_PERIODS.map((_unused, i) => i);

    for (const periodIndex of activeIndices) {
      const period = SAMPLE_PERIODS[periodIndex];
      if (!period) continue;

      for (let n = 0; n < spec.invoicesPerPeriod; n += 1) {
        const day = randomInt(2, 26);
        const invoiceDate = dayInPeriod(period, day);
        const taxable = spec.baseTaxable + randomInt(-12, 12) * 1000;
        const tax = taxFor(spec, taxable);
        const serial = periodIndex * 10 + n + 1;
        const invoiceNumber = `${spec.code}/${period.slice(0, 4)}/${String(serial).padStart(3, '0')}`;

        const book: BookRecord = {
          supplier: spec,
          gstinInRegister: gstin,
          invoiceNumber,
          invoiceDate,
          taxable,
          ...tax,
          docType: 'Invoice',
          natureOfSupply: '',
          itcEligible: 'Yes',
          period,
        };

        applyBehaviour(spec, book, gstin, period, periodIndex, invoiceNumber, invoiceDate, taxable, tax);
      }
    }
  }
}

function applyBehaviour(
  spec: SupplierSpec,
  book: BookRecord,
  gstin: string,
  period: string,
  periodIndex: number,
  invoiceNumber: string,
  invoiceDate: string,
  taxable: number,
  tax: { cgst: number; sgst: number; igst: number },
) {
  const total = taxable + tax.cgst + tax.sgst + tax.igst;

  const acceptInIms = (actionPeriod: string) =>
    pushIms({
      gstin,
      invoiceNumber,
      invoiceDate,
      value: total,
      action: 'Accept',
      actionDate: dayInPeriod(addMonths(actionPeriod, 1) ?? actionPeriod, 13),
      remark: '',
      recordType: 'Invoice',
      period: actionPeriod,
    });

  const reportOnTime = (itcAvailable = 'Yes') => {
    portalRecords.push({
      section: 'b2b',
      supplier: spec,
      gstin,
      invoiceNumber,
      invoiceDate,
      taxable,
      ...tax,
      filingDate: filingDateFor(period, 0),
      itcAvailable,
      reverseCharge: 'N',
      period,
    });
  };

  switch (spec.behaviour) {
    case 'chronic_late': {
      /*
       * Roughly 60% of the value arrives at all: about a third on time, about a third
       * one to three months late, and the rest never. The mix matters -- a supplier who
       * is uniformly late has no volatility, and it is the erratic ones that are hardest
       * to plan cash around.
       */
      bookRecords.push(book);
      const roll = random();
      if (roll < 0.28) {
        reportOnTime();
        acceptInIms(period);
      } else if (roll < 0.62) {
        const late = randomInt(1, 3);
        const arrival = addMonths(period, late);
        if (arrival && SAMPLE_PERIODS.includes(arrival)) {
          portalRecords.push({
            section: 'b2b',
            supplier: spec,
            gstin,
            invoiceNumber,
            invoiceDate,
            taxable,
            ...tax,
            filingDate: filingDateFor(period, late, 4),
            itcAvailable: 'Yes',
            reverseCharge: 'N',
            period: arrival,
          });
          acceptInIms(arrival);
        }
      }
      break;
    }

    case 'buyer_rejected': {
      /*
       * The story that proves the attribution layer matters. The supplier filed
       * correctly and on time, but the buyer's own staff rejected the record in IMS, so
       * it never reached GSTR-2B. Without the IMS log this supplier looks like a total
       * failure; with it, the finding belongs to the buyer.
       */
      bookRecords.push(book);
      pushIms({
        gstin,
        invoiceNumber,
        invoiceDate,
        value: total,
        action: 'Reject',
        actionDate: dayInPeriod(addMonths(period, 1) ?? period, 12),
        remark: 'Rejected in IMS - PO number not quoted on invoice',
        recordType: 'Invoice',
        period,
      });
      break;
    }

    case 'quarterly': {
      // Files at the end of their quarter, exactly as QRMP permits.
      bookRecords.push(book);
      const quarterEndOffset = (2 - ((periodIndex + 2) % 3) + 3) % 3;
      const arrival = addMonths(period, quarterEndOffset);
      if (arrival && SAMPLE_PERIODS.includes(arrival)) {
        portalRecords.push({
          section: 'b2b',
          supplier: spec,
          gstin,
          invoiceNumber,
          invoiceDate,
          taxable,
          ...tax,
          filingDate: filingDateFor(arrival, 0, 2),
          itcAvailable: 'Yes',
          reverseCharge: 'N',
          period: arrival,
        });
        acceptInIms(arrival);
      }
      break;
    }

    case 'wrong_buyer_gstin': {
      // The supplier reported the document against a mistyped buyer GSTIN, so it landed
      // in a stranger's 2B and never appears in ours at all.
      bookRecords.push(book);
      break;
    }

    case 'march_collapse': {
      bookRecords.push(book);
      // Periods 0-5 are clean; March 2026 (index 6) and after, nothing arrives.
      if (periodIndex < 6) {
        reportOnTime();
        acceptInIms(period);
      }
      break;
    }

    case 'number_drift': {
      /*
       * The books carry the supplier's full invoice number; the portal carries a short
       * form. Normalisation cannot reconcile them, so this is what match tier 3 -- same
       * taxable value, same date to within a few days -- exists to catch.
       */
      bookRecords.push(book);
      portalRecords.push({
        section: 'b2b',
        supplier: spec,
        gstin,
        invoiceNumber: `SE ${String(periodIndex * 10 + 1)}`,
        invoiceDate,
        taxable,
        ...tax,
        filingDate: filingDateFor(period, 0),
        itcAvailable: 'Yes',
        reverseCharge: 'N',
        period,
      });
      break;
    }

    case 'forgotten_pending': {
      bookRecords.push(book);
      /*
       * Two documents from the earliest periods were left pending and forgotten.
       *
       * A record held Pending in IMS does not flow into GSTR-2B at all, so those two are
       * deliberately absent from the portal file as well as marked pending in the log.
       * That is what makes them a real gap the buyer caused themselves, and what puts
       * them in front of the 30 November countdown.
       */
      const forgotten = periodIndex <= 1;
      if (!forgotten) reportOnTime();
      pushIms({
        gstin,
        invoiceNumber,
        invoiceDate,
        value: total,
        action: forgotten ? 'Pending' : 'Accept',
        actionDate: dayInPeriod(addMonths(period, 1) ?? period, 13),
        remark: forgotten ? 'Held pending supplier confirmation' : '',
        recordType: 'Invoice',
        period,
      });
      break;
    }

    case 'rejected_credit_note': {
      bookRecords.push(book);
      reportOnTime();
      acceptInIms(period);

      // One credit note per period, and the buyer rejected the one in December.
      if (periodIndex === 3) {
        const noteNumber = `${spec.code}/CN/${String(periodIndex + 1).padStart(3, '0')}`;
        const noteTaxable = Math.round(taxable * 0.15);
        const noteTax = taxFor(spec, noteTaxable);

        bookRecords.push({
          supplier: spec,
          gstinInRegister: gstin,
          invoiceNumber: noteNumber,
          invoiceDate: dayInPeriod(period, 27),
          taxable: noteTaxable,
          ...noteTax,
          docType: 'Credit Note',
          natureOfSupply: 'Rate difference',
          itcEligible: 'Yes',
          period,
        });

        portalRecords.push({
          section: 'cdnr',
          supplier: spec,
          gstin,
          invoiceNumber: noteNumber,
          invoiceDate: dayInPeriod(period, 27),
          taxable: noteTaxable,
          ...noteTax,
          // Offset so the credit-note sheet, which holds only a row or two, still
          // contains a day above 12 and is therefore readable without a prompt.
          filingDate: filingDateFor(period, 0, 6),
          itcAvailable: 'Yes',
          reverseCharge: 'N',
          noteType: 'Credit Note',
          period,
        });

        pushIms({
          gstin,
          invoiceNumber: noteNumber,
          invoiceDate: dayInPeriod(period, 27),
          value: noteTaxable + noteTax.cgst + noteTax.sgst + noteTax.igst,
          action: 'Reject',
          actionDate: dayInPeriod(addMonths(period, 1) ?? period, 14),
          remark: 'Rejected - credit note not agreed by purchase team',
          recordType: 'Credit Note',
          period,
        });
      }
      break;
    }

    case 'blocked_17_5': {
      // Motor vehicles: credit is blocked, so this must never appear in at-risk.
      book.natureOfSupply = 'Blocked u/s 17(5) - motor vehicle purchase';
      book.itcEligible = 'No';
      bookRecords.push(book);
      reportOnTime('No');
      break;
    }

    case 'pan_state_mismatch': {
      // Reported under the same PAN but a different state registration.
      bookRecords.push(book);
      portalRecords.push({
        section: 'b2b',
        supplier: spec,
        gstin: makeGstin('27', spec.pan, '2'),
        invoiceNumber,
        invoiceDate,
        taxable,
        ...tax,
        filingDate: filingDateFor(period, 0),
        itcAvailable: 'Yes',
        reverseCharge: 'N',
        period,
      });
      break;
    }

    case 'new_supplier':
    case 'clean':
    default: {
      bookRecords.push(book);
      /*
       * A little ordinary friction: nearly everything arrives on time, a little slips a
       * month. These suppliers should score green. A scorecard where two thirds of the
       * page is amber teaches its reader to ignore amber, and then the three suppliers
       * that genuinely matter get ignored with it.
       */
      if (random() < 0.985) {
        const slip = random() < 0.04 ? 1 : 0;
        const arrival = addMonths(period, slip);
        if (arrival && SAMPLE_PERIODS.includes(arrival)) {
          portalRecords.push({
            section: 'b2b',
            supplier: spec,
            gstin,
            invoiceNumber,
            invoiceDate,
            taxable,
            ...tax,
            filingDate: filingDateFor(period, slip),
            itcAvailable: 'Yes',
            reverseCharge: 'N',
            period: arrival,
          });
          acceptInIms(arrival);
        }
      }
      break;
    }
  }
}

// -------------------------------------------------------------- dirty rows

/**
 * Deliberate mess, so Data Health has something real to report.
 *
 * Note what is *not* done here: no value is written in MM/DD where the column is
 * otherwise DD/MM. Mixing those in one column makes it genuinely undecidable, and the
 * engine would correctly refuse to proceed -- which would block the one-click demo. The
 * "different date format" rows use ISO instead, which is a different format that is
 * still unambiguous.
 */
function applyDirtyRows() {
  const inFirstPeriod = bookRecords.filter((r) => r.period === SAMPLE_PERIODS[0]);

  // Three blank GSTINs.
  for (const index of [3, 11, 19]) {
    const row = inFirstPeriod[index];
    if (row) row.gstinInRegister = '';
  }

  // One broken check digit: last character advanced by one.
  const badDigitRow = inFirstPeriod[7];
  if (badDigitRow) {
    const gstin = badDigitRow.gstinInRegister;
    const last = gstin.slice(14);
    const replacement = last === 'Z' ? 'Y' : String.fromCharCode(last.charCodeAt(0) + 1);
    badDigitRow.gstinInRegister = `${gstin.slice(0, 14)}${replacement}`;
  }
}

// ------------------------------------------------------------------ writing

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(HERE, 'sample');

function formatDate(date: string, style: 'dmy' | 'iso'): string {
  if (style === 'iso') return date;
  const [year, month, day] = date.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

function withCommas(value: number): string {
  // Indian grouping, as a spreadsheet would have stored it as text.
  const text = String(Math.round(value));
  const last3 = text.slice(-3);
  const rest = text.slice(0, -3);
  if (rest === '') return last3;
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Array<Array<string | number>>): string {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

function writeRegisters(): string[] {
  const written: string[] = [];

  for (const [periodIndex, period] of SAMPLE_PERIODS.entries()) {
    const rows: Array<Array<string | number>> = [
      ['Sharma Enterprises Private Limited'],
      [`Purchase Register for the period ${period}`],
      [`GSTIN: ${BUYER_GSTIN}`],
      [],
      [
        'Supplier Name',
        'GSTIN',
        'Invoice No',
        'Invoice Date',
        'Taxable Value',
        'CGST',
        'SGST',
        'IGST',
        'Cess',
        'Doc Type',
        'ITC Eligible',
        'Nature of Supply',
      ],
    ];

    const forPeriod = bookRecords.filter((r) => r.period === period);

    for (const [rowIndex, record] of forPeriod.entries()) {
      // Two rows per file carry an ISO date rather than the column's usual DD/MM.
      const dateStyle: 'dmy' | 'iso' = rowIndex === 2 || rowIndex === 9 ? 'iso' : 'dmy';
      // A handful of amounts stored as text with Indian grouping.
      const asText = rowIndex % 7 === 3;

      rows.push([
        record.supplier.name,
        record.gstinInRegister,
        record.invoiceNumber,
        formatDate(record.invoiceDate, dateStyle),
        asText ? withCommas(record.taxable) : record.taxable,
        asText ? withCommas(record.cgst) : record.cgst,
        asText ? withCommas(record.sgst) : record.sgst,
        asText ? withCommas(record.igst) : record.igst,
        0,
        record.docType,
        record.itcEligible,
        record.natureOfSupply,
      ]);
    }

    const totals = forPeriod.reduce(
      (acc, r) => ({
        taxable: acc.taxable + r.taxable,
        cgst: acc.cgst + r.cgst,
        sgst: acc.sgst + r.sgst,
        igst: acc.igst + r.igst,
      }),
      { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
    );
    rows.push([
      'Grand Total',
      '',
      '',
      '',
      totals.taxable,
      totals.cgst,
      totals.sgst,
      totals.igst,
      0,
      '',
      '',
      '',
    ]);

    const fileName = `purchase-register-${period}.csv`;
    writeFileSync(join(SAMPLE_DIR, fileName), toCsv(rows), 'utf8');
    written.push(fileName);
    void periodIndex;
  }

  return written;
}

function writeTwoB(): string[] {
  const written: string[] = [];

  for (const period of SAMPLE_PERIODS) {
    const book = XLSX.utils.book_new();

    const b2bHeader = [
      'GSTIN of supplier',
      'Trade/Legal name',
      'Invoice number',
      'Invoice Date',
      'Invoice Value(₹)',
      'Taxable Value (₹)',
      'Integrated Tax(₹)',
      'Central Tax(₹)',
      'State/UT Tax(₹)',
      'Cess(₹)',
      'GSTR-1/IFF/GSTR-5 Period',
      'GSTR-1/IFF/GSTR-5 Filing Date',
      'ITC Availability',
      'Reason',
      'Supply Attract Reverse Charge',
    ];

    const forPeriod = portalRecords.filter((r) => r.period === period);

    const b2bRows = forPeriod
      .filter((r) => r.section === 'b2b')
      .map((r) => [
        r.gstin,
        r.supplier.name,
        r.invoiceNumber,
        formatDate(r.invoiceDate, 'dmy'),
        r.taxable + r.cgst + r.sgst + r.igst,
        r.taxable,
        r.igst,
        r.cgst,
        r.sgst,
        0,
        periodFromDate(r.filingDate) ?? '',
        formatDate(r.filingDate, 'dmy'),
        r.itcAvailable,
        r.itcAvailable === 'No' ? 'ITC unavailable - blocked credit' : '',
        r.reverseCharge,
      ]);

    const b2bSheet = XLSX.utils.aoa_to_sheet([
      ['Goods and Services Tax - GSTR-2B'],
      [`Return Period: ${period}`],
      [`GSTIN: ${BUYER_GSTIN}`],
      [],
      b2bHeader,
      ...b2bRows,
    ]);
    XLSX.utils.book_append_sheet(book, b2bSheet, 'B2B');

    const cdnrRows = forPeriod
      .filter((r) => r.section === 'cdnr')
      .map((r) => [
        r.gstin,
        r.supplier.name,
        r.noteType ?? 'Credit Note',
        r.invoiceNumber,
        formatDate(r.invoiceDate, 'dmy'),
        r.taxable + r.cgst + r.sgst + r.igst,
        r.taxable,
        r.igst,
        r.cgst,
        r.sgst,
        0,
        periodFromDate(r.filingDate) ?? '',
        formatDate(r.filingDate, 'dmy'),
        r.itcAvailable,
        r.reverseCharge,
      ]);

    const cdnrSheet = XLSX.utils.aoa_to_sheet([
      ['Goods and Services Tax - GSTR-2B'],
      [`Return Period: ${period}`],
      [],
      [
        'GSTIN of supplier',
        'Trade/Legal name',
        'Note type',
        'Note number',
        'Note date',
        'Note Value(₹)',
        'Taxable Value (₹)',
        'Integrated Tax(₹)',
        'Central Tax(₹)',
        'State/UT Tax(₹)',
        'Cess(₹)',
        'GSTR-1/IFF/GSTR-5 Period',
        'GSTR-1/IFF/GSTR-5 Filing Date',
        'ITC Availability',
        'Supply Attract Reverse Charge',
      ],
      ...cdnrRows,
    ]);
    XLSX.utils.book_append_sheet(book, cdnrSheet, 'B2B-CDNR');

    const fileName = `gstr2b-${period}.xlsx`;
    const buffer = XLSX.write(book, {
      type: 'buffer',
      bookType: 'xlsx',
      // Compressed, because these bytes are also embedded in the app bundle so that
      // "Load sample data" can run without a single network request.
      compression: true,
    }) as Buffer;
    writeFileSync(join(SAMPLE_DIR, fileName), buffer);
    written.push(fileName);
  }

  return written;
}

function writeImsLogs(): string[] {
  const written: string[] = [];

  for (const period of SAMPLE_PERIODS) {
    const rows: Array<Array<string | number>> = [
      [
        'GSTIN',
        'Invoice No',
        'Invoice Date',
        'Value',
        'Action',
        'Date of Action',
        'Remark',
        'Record Type',
      ],
    ];

    for (const record of imsRecords.filter((r) => r.period === period)) {
      rows.push([
        record.gstin,
        record.invoiceNumber,
        formatDate(record.invoiceDate, 'dmy'),
        record.value,
        record.action,
        formatDate(record.actionDate, 'dmy'),
        record.remark,
        record.recordType,
      ]);
    }

    const fileName = `ims-log-${period}.csv`;
    writeFileSync(join(SAMPLE_DIR, fileName), toCsv(rows), 'utf8');
    written.push(fileName);
  }

  return written;
}

function writeSupplierMaster(): string {
  const rows: Array<Array<string | number>> = [
    [
      'Supplier Name',
      'GSTIN',
      'Contact Person',
      'Email',
      'Phone',
      'Payment Terms',
      'Filing Frequency',
    ],
  ];

  for (const spec of SUPPLIERS) {
    rows.push([
      spec.name,
      makeGstin(spec.stateCode, spec.pan),
      spec.contact.person,
      spec.contact.email,
      spec.contact.phone,
      spec.contact.terms,
      spec.behaviour === 'quarterly' ? 'Quarterly' : 'Monthly',
    ]);
  }

  const fileName = 'supplier-master.csv';
  writeFileSync(join(SAMPLE_DIR, fileName), toCsv(rows), 'utf8');
  return fileName;
}

// ------------------------------------------------------------------ bundle

/**
 * Emits the sample dataset a second time, as a TypeScript module.
 *
 * This exists because of the no-network rule. "Load sample data" must reach a full
 * dashboard in one click, and fetching the committed files -- even from the app's own
 * origin -- would be a network request, which the Content-Security-Policy forbids and
 * the lint rules refuse to compile. Embedding the bytes means the demo runs the exact
 * same files a user can download and open, through the exact same parsers.
 */
function writeBundle(fileNames: { registers: string[]; twoB: string[]; ims: string[]; master: string }) {
  const lines: string[] = [
    '/* GENERATED FILE -- do not edit. Run `npm run fixtures` to regenerate. */',
    '',
    "import type { FileKind } from '../engine/types';",
    '',
    '/**',
    ' * The sample dataset, embedded so it can be loaded with no network request.',
    ' * CSV files are carried as text; the GSTR-2B workbooks are base64 of the real .xlsx',
    ' * bytes committed alongside this file in ./sample.',
    ' */',
    'export interface SampleFileEntry {',
    '  kind: FileKind;',
    '  fileName: string;',
    '  period: string | null;',
    '  text?: string;',
    '  base64?: string;',
    '}',
    '',
    `export const SAMPLE_AS_OF = ${JSON.stringify(SAMPLE_AS_OF)};`,
    `export const SAMPLE_BUYER_GSTIN = ${JSON.stringify(BUYER_GSTIN)};`,
    `export const SAMPLE_PERIOD_KEYS = ${JSON.stringify(SAMPLE_PERIODS)};`,
    '',
    'export const SAMPLE_FILES: SampleFileEntry[] = [',
  ];

  const entry = (kind: string, fileName: string, period: string | null) => {
    const path = join(SAMPLE_DIR, fileName);
    if (fileName.endsWith('.xlsx')) {
      const base64 = readFileSync(path).toString('base64');
      lines.push(
        `  { kind: '${kind}', fileName: ${JSON.stringify(fileName)}, period: ${JSON.stringify(period)}, base64: ${JSON.stringify(base64)} },`,
      );
    } else {
      const text = readFileSync(path, 'utf8');
      lines.push(
        `  { kind: '${kind}', fileName: ${JSON.stringify(fileName)}, period: ${JSON.stringify(period)}, text: ${JSON.stringify(text)} },`,
      );
    }
  };

  const periodOf = (fileName: string) => {
    const match = /(\d{4}-\d{2})/.exec(fileName);
    return match?.[1] ?? null;
  };

  for (const name of fileNames.registers) entry('purchaseRegister', name, periodOf(name));
  for (const name of fileNames.twoB) entry('gstr2b', name, periodOf(name));
  for (const name of fileNames.ims) entry('imsLog', name, periodOf(name));
  entry('supplierMaster', fileNames.master, null);

  lines.push('];', '');
  writeFileSync(join(HERE, 'sampleBundle.ts'), lines.join('\n'), 'utf8');
}

// ------------------------------------------------------------------- main

function main() {
  mkdirSync(SAMPLE_DIR, { recursive: true });

  generate();
  applyDirtyRows();

  const registers = writeRegisters();
  const twoB = writeTwoB();
  const ims = writeImsLogs();
  const master = writeSupplierMaster();
  writeBundle({ registers, twoB, ims, master });

  console.log('Sample dataset written to src/fixtures/sample/');
  console.log(`  suppliers        ${String(SUPPLIERS.length)}`);
  console.log(`  periods          ${String(SAMPLE_PERIODS.length)}`);
  console.log(`  book documents   ${String(bookRecords.length)}`);
  console.log(`  GSTR-2B rows     ${String(portalRecords.length)}`);
  console.log(`  IMS actions      ${String(imsRecords.length)}`);
  console.log(
    `  files            ${String(registers.length + twoB.length + ims.length + 1)} (${master} and ${String(registers.length + twoB.length + ims.length)} period files)`,
  );
}

main();
