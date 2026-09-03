import { describe, expect, it } from 'vitest';
import {
  addMonths,
  daysBetween,
  financialYearOfDate,
  formatPeriod,
  isWithinOnTimeWindow,
  monthsBetween,
  periodFromDate,
  periodRange,
  quarterOfPeriod,
  section16_4Deadline,
} from './period';

describe('periodFromDate', () => {
  it('takes the calendar month of the invoice date', () => {
    expect(periodFromDate('2026-04-05')).toBe('2026-04');
    expect(periodFromDate('2026-03-31')).toBe('2026-03');
  });

  it('returns null for a malformed date', () => {
    expect(periodFromDate('2026-04')).toBeNull();
    expect(periodFromDate('rubbish')).toBeNull();
  });
});

describe('addMonths and monthsBetween', () => {
  it('crosses a year boundary in both directions', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-02', -3)).toBe('2025-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });

  it('counts whole months, signed', () => {
    expect(monthsBetween('2026-04', '2026-07')).toBe(3);
    expect(monthsBetween('2026-04', '2026-04')).toBe(0);
    expect(monthsBetween('2026-07', '2026-04')).toBe(-3);
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
  });
});

describe('financialYearOfDate', () => {
  it('starts the year on 1 April', () => {
    expect(financialYearOfDate('2026-04-01')?.label).toBe('2026-27');
    expect(financialYearOfDate('2026-03-31')?.label).toBe('2025-26');
    expect(financialYearOfDate('2026-12-31')?.label).toBe('2026-27');
    expect(financialYearOfDate('2027-01-01')?.label).toBe('2026-27');
  });
});

describe('section16_4Deadline', () => {
  it('is 30 November following the end of the invoice financial year', () => {
    // Both of these sit in FY 2025-26, so both expire on the same day -- but the
    // February invoice has nine months of slack and the May one has eighteen.
    expect(section16_4Deadline('2025-05-10')).toBe('2026-11-30');
    expect(section16_4Deadline('2026-02-10')).toBe('2026-11-30');
  });

  it('moves to the next year once the financial year rolls over', () => {
    expect(section16_4Deadline('2026-03-31')).toBe('2026-11-30');
    expect(section16_4Deadline('2026-04-01')).toBe('2027-11-30');
  });
});

describe('quarterOfPeriod', () => {
  it('follows the financial year, not the calendar year', () => {
    expect(quarterOfPeriod('2026-04')?.index).toBe(1);
    expect(quarterOfPeriod('2026-06')?.index).toBe(1);
    expect(quarterOfPeriod('2026-07')?.index).toBe(2);
    expect(quarterOfPeriod('2026-10')?.index).toBe(3);
    expect(quarterOfPeriod('2027-01')?.index).toBe(4);
  });

  it('spans the calendar year boundary for Q4', () => {
    const q4 = quarterOfPeriod('2027-02');
    expect(q4?.startPeriod).toBe('2027-01');
    expect(q4?.endPeriod).toBe('2027-03');
  });

  it('gives the right bounds for Q1', () => {
    const q1 = quarterOfPeriod('2026-05');
    expect(q1?.startPeriod).toBe('2026-04');
    expect(q1?.endPeriod).toBe('2026-06');
  });
});

describe('isWithinOnTimeWindow', () => {
  it('holds a monthly filer to the expected period', () => {
    expect(isWithinOnTimeWindow('2026-04', '2026-04', 'monthly')).toBe(true);
    expect(isWithinOnTimeWindow('2026-04', '2026-05', 'monthly')).toBe(false);
  });

  it('does not penalise a quarterly filer for filing quarterly', () => {
    // An April invoice from a QRMP supplier appearing in the June 2B is on time: that
    // is when their GSTR-1 is due. Scoring them down for using a scheme the law offers
    // is the fastest way to lose a user's trust in the whole scorecard.
    expect(isWithinOnTimeWindow('2026-04', '2026-04', 'quarterly')).toBe(true);
    expect(isWithinOnTimeWindow('2026-04', '2026-05', 'quarterly')).toBe(true);
    expect(isWithinOnTimeWindow('2026-04', '2026-06', 'quarterly')).toBe(true);
  });

  it('still marks a quarterly filer late once their quarter has closed', () => {
    expect(isWithinOnTimeWindow('2026-04', '2026-07', 'quarterly')).toBe(false);
  });

  it('handles a quarter that crosses the calendar year', () => {
    expect(isWithinOnTimeWindow('2027-01', '2027-03', 'quarterly')).toBe(true);
    expect(isWithinOnTimeWindow('2027-01', '2027-04', 'quarterly')).toBe(false);
  });

  it('treats an early arrival as on time', () => {
    expect(isWithinOnTimeWindow('2026-05', '2026-04', 'monthly')).toBe(true);
  });
});

describe('daysBetween', () => {
  it('counts calendar days with no timezone component', () => {
    expect(daysBetween('2026-11-01', '2026-11-30')).toBe(29);
    expect(daysBetween('2026-11-30', '2026-11-01')).toBe(-29);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('crosses a leap day correctly', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2025-02-28', '2025-03-01')).toBe(1);
  });

  it('is unaffected by daylight-saving transitions elsewhere in the world', () => {
    // Pure UTC arithmetic: March has 31 days no matter where the reader is sitting.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });
});

describe('periodRange', () => {
  it('lists every period inclusive of both ends', () => {
    expect(periodRange('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('returns a single period when both ends match, and nothing when reversed', () => {
    expect(periodRange('2026-04', '2026-04')).toEqual(['2026-04']);
    expect(periodRange('2026-06', '2026-04')).toEqual([]);
  });
});

describe('formatPeriod', () => {
  it('renders a period the way a user would say it', () => {
    expect(formatPeriod('2026-04')).toBe('Apr 2026');
    expect(formatPeriod('2027-01')).toBe('Jan 2027');
  });
});
