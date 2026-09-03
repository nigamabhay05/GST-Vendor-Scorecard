import { describe, expect, it } from 'vitest';
import { analyseDateColumn, fromExcelSerial, isRealDate, parseDateOnly } from './dates';

describe('fromExcelSerial', () => {
  it('converts a serial number to the right calendar date', () => {
    // 45387 is 5 April 2024 in Excel's 1900 date system (2024-01-01 is serial 45292).
    expect(fromExcelSerial(45387)).toBe('2024-04-05');
    expect(fromExcelSerial(46117)).toBe('2026-04-05');
  });

  it('ignores a fractional time component rather than shifting the date', () => {
    expect(fromExcelSerial(46117.75)).toBe('2026-04-05');
  });

  it('rejects serials inside Excel 1900 leap-year bug window and out-of-range values', () => {
    expect(fromExcelSerial(60)).toBeNull();
    expect(fromExcelSerial(0)).toBeNull();
    expect(fromExcelSerial(-5)).toBeNull();
    expect(fromExcelSerial(999_999)).toBeNull();
    expect(fromExcelSerial(Number.NaN)).toBeNull();
  });
});

describe('parseDateOnly', () => {
  it('reads an Excel serial arriving as a number', () => {
    expect(parseDateOnly(46117).value).toBe('2026-04-05');
  });

  it('reads an Excel serial arriving as text', () => {
    expect(parseDateOnly('46117').value).toBe('2026-04-05');
  });

  it('reads DD/MM/YYYY', () => {
    expect(parseDateOnly('25/04/2026').value).toBe('2026-04-25');
  });

  it('reads DD-MM-YYYY', () => {
    expect(parseDateOnly('25-04-2026').value).toBe('2026-04-25');
  });

  it('reads YYYY-MM-DD', () => {
    expect(parseDateOnly('2026-04-25').value).toBe('2026-04-25');
  });

  it('reads a two-digit year', () => {
    expect(parseDateOnly('25/04/26').value).toBe('2026-04-25');
    expect(parseDateOnly('25/04/99').value).toBe('1999-04-25');
  });

  it('discards a time component instead of applying it', () => {
    // A timezone-aware parse of this value can land on 24 April, which would move a
    // 31 March invoice into the previous financial year.
    expect(parseDateOnly('2026-04-25T00:00:00.000Z').value).toBe('2026-04-25');
    expect(parseDateOnly('2026-04-25 18:30:00').value).toBe('2026-04-25');
  });

  it('reads a Date object in UTC, never in local time', () => {
    expect(parseDateOnly(new Date(Date.UTC(2026, 2, 31))).value).toBe('2026-03-31');
  });

  it('refuses to guess when DD/MM and MM/DD are both possible', () => {
    // The rule from the brief: stop and ask rather than guess.
    const result = parseDateOnly('05/04/2026');
    expect(result.value).toBeNull();
    expect(result.problem).toBe('ambiguous');
  });

  it('uses the resolved column format once it is known', () => {
    expect(parseDateOnly('05/04/2026', 'DMY').value).toBe('2026-04-05');
    expect(parseDateOnly('05/04/2026', 'MDY').value).toBe('2026-05-04');
  });

  it('does not need a hint when the value settles its own format', () => {
    // 25 cannot be a month, so this is unambiguous whatever the column says.
    expect(parseDateOnly('25/04/2026', 'MDY').value).toBe('2026-04-25');
  });

  it('reports blanks as blank', () => {
    for (const blank of ['', '  ', '-', 'NA', null, undefined]) {
      expect(parseDateOnly(blank).problem).toBe('blank');
    }
  });

  it('reports nonsense as unparseable', () => {
    for (const bad of ['not a date', '2026/13/45', '32/01/2026', '2026-02-30']) {
      const result = parseDateOnly(bad);
      expect(result.value).toBeNull();
      expect(result.problem).toBe('unparseable');
    }
  });
});

describe('isRealDate', () => {
  it('rejects days that do not exist in that month', () => {
    expect(isRealDate(2026, 2, 30)).toBe(false);
    expect(isRealDate(2026, 4, 31)).toBe(false);
    expect(isRealDate(2025, 2, 29)).toBe(false);
  });

  it('accepts a genuine leap day', () => {
    expect(isRealDate(2024, 2, 29)).toBe(true);
  });
});

describe('analyseDateColumn', () => {
  it('resolves DMY from a single value that can only be a day', () => {
    // One value of 25/04 settles the whole column, including the ambiguous ones.
    const result = analyseDateColumn(['05/04/2026', '25/04/2026', '06/04/2026']);
    expect(result.resolved).toBe('DMY');
    expect(result.ambiguous).toBe(false);
  });

  it('resolves MDY from a second component above twelve', () => {
    const result = analyseDateColumn(['04/25/2026', '05/04/2026']);
    expect(result.resolved).toBe('MDY');
    expect(result.ambiguous).toBe(false);
  });

  it('raises the prompt when nothing in the column resolves it', () => {
    // Every value works read either way. This is the case that must reach the user.
    const result = analyseDateColumn(['05/04/2026', '06/07/2026', '01/02/2026']);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.samples.length).toBeGreaterThan(0);
  });

  it('raises the prompt when the column proves both readings', () => {
    // A column containing both 25/04 and 04/25 is not internally consistent; picking
    // either reading would corrupt half the rows.
    const result = analyseDateColumn(['25/04/2026', '04/25/2026']);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it('is not ambiguous when the column holds no slash dates at all', () => {
    expect(analyseDateColumn(['2026-04-05', '2026-04-25']).ambiguous).toBe(false);
    expect(analyseDateColumn([46113, 46114]).ambiguous).toBe(false);
    expect(analyseDateColumn([]).ambiguous).toBe(false);
  });

  it('ignores blanks when weighing the evidence', () => {
    const result = analyseDateColumn(['', '   ', '25/04/2026', 'NA']);
    expect(result.resolved).toBe('DMY');
  });
});
