# Assumptions

Where GST practice is ambiguous, or where the brief left room for interpretation, this
file records what was decided and why. Anything here is a candidate for disagreement —
that is the point of writing it down rather than burying it in the code.

Constants referred to below live in [`src/engine/config.ts`](src/engine/config.ts).

---

## Periods and timing

**An invoice belongs to the calendar month of its invoice date.**
A monthly filer reports that month in GSTR-1 by the 11th of the following month, and the
buyer's GSTR-2B for the month is generated on the 14th. So the period a document *should*
appear in is the month it was dated. The 12th-to-11th cut-off window is not modelled
separately; the observed 2B period is taken as fact from the file.

**A quarterly (QRMP) filer is on time anywhere within their quarter.**
Quarters follow the financial year: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar. An April invoice
appearing in the June 2B is on time. Delay used for scoring is measured *beyond* this
window, so a compliant QRMP supplier has a delay of zero.

**"Not yet due" is not the same as "missing".**
A document whose on-time window closes after the newest GSTR-2B loaded is excluded from
ITC at risk and from the match-rate denominator. Without this, every quarterly filer would
carry a permanent red flag for the whole of each open quarter, and a monthly supplier
would be flagged whenever the latest 2B had not been downloaded yet. This is not stated in
the brief; it was added because the sample data showed a compliant QRMP supplier scoring
amber with zero late invoices.

**Section 16(4) is modelled as 30 November following the 31 March financial year end.**
The statute says "the 30th day of November following the end of the financial year, or
furnishing of the annual return, whichever is earlier". The annual-return limb is *not*
modelled: the tool has no way to know when a return was filed. So the deadline shown is
the later of the two possibilities, which means it can be **optimistic** where an annual
return was filed early.

---

## Matching

**"Exact value" is read as "equal within the ₹1 tolerance."**
The brief describes match tier 3 as requiring an exact taxable value. Exact equality
between two floating-point rupee figures — one rounded per line by Tally, one rounded per
document by the portal — is not a meaningful test, and would cause tier 3 to fail on
documents that are in fact identical. Every value comparison uses `MONEY.toleranceRupees`.

**"Value" in tiers 1, 4 and 5 means total tax** (CGST + SGST + IGST + cess). Tier 3 uses
the taxable value, as the brief specifies.

**Match tiers 4 and 5 are counted in neither received credit nor ITC at risk.**
They are reported as their own "needs correction" category. The credit exists but is not
usable as it stands, so counting it either way would overstate one figure or the other.
The value is carried separately on each supplier so it does not vanish from view.

**Debit notes are matched like invoices.** They increase ITC, so they behave the same way.
Their section 16(4) clock runs from the debit note's own date.

**Credit notes never enter invoice matching.** They are tracked separately, and the
category that matters is the ones rejected in IMS.

---

## Identity

**One buyer GSTIN per project.** This matches how GSTR-3B is actually filed — one return
per registration. A group with several registrations runs the tool once per GSTIN.

**A blank or check-digit-failing GSTIN is resolved to a supplier by name.**
A register row with a missing or mistyped GSTIN still belongs to a supplier, and letting
it create a second scorecard row for the same business is both wrong and corrosive to
trust in the table. Two *valid* GSTINs under one name are never merged: that is a supplier
with more than one state registration, which is what match tier 4 exists to report.

**A failed check digit is a warning, never a rejection.** The row is kept and matched
normally. A bug in the checksum — or an unusual but genuine GSTIN — must not be able to
silently delete a supplier's history.

---

## Money and dates

**`Dr` and `Cr` suffixes are stripped without changing the sign.**
In a purchase register the direction of a document is carried by its document type. Some
Tally exports do use `Cr` to mean a credit; inferring that from two letters in an amount
cell would be a guess about someone else's export settings, and would silently flip
credit notes. If your export relies on `Dr`/`Cr` for direction, map the document type
column instead.

**Negatives in parentheses are negative.** `(1,200)` is −1200.

**Excel serials below 61 are rejected.** They fall inside Excel's deliberate 1900
leap-year bug window (January and February 1900). No GST document carries such a date.

**A bare integer in a date column is treated as an Excel serial** when it falls in the
plausible range 61–73050 (1 March 1900 to 31 December 2099).

**Two-digit years: `< 50` becomes 20xx, otherwise 19xx.**

**Ambiguous `DD/MM` vs `MM/DD` columns stop and ask.** Format is decided per column, not
per cell, so one value of `25/04/2026` settles every ambiguous value in the same column.
Only when nothing in the column resolves it — or when the column proves *both* readings,
which means it is not internally consistent — is the user asked. This blocks results
rather than warning about them, because reading a column the wrong way round corrupts
every delay figure invisibly.

---

## Scoring

**Recovery rate: a gap counts as recovered if the invoice appears in any later loaded
period.** This carries a known bias, stated in the interface as well as here: an older gap
has had more periods in which to resolve than a recent one, so the rate reads slightly
pessimistic on the newest month and expected cash loss there reads high. Gaps in the
newest period are excluded from the rate entirely, since they have had no chance to
resolve.

**Credit the buyer rejected or kept pending is excluded from the match-rate denominator.**
The brief says only supplier-attributed gaps affect the score. Leaving these in gives a
supplier who filed everything correctly a match rate of zero — the opposite of the truth,
and the exact failure the IMS attribution layer exists to prevent. The money is still
reported as ITC at risk, because the buyer really has lost it.

**Volatility is the population standard deviation** of the monthly match rate across
periods that have data. Periods where a supplier had no in-scope purchases are `null`, not
zero — a month with no business says nothing about a supplier, and averaging a zero into
it would.

**Concentration uses a supplier's whole in-scope volume**, including credit the buyer
rejected. It answers "how much of my credit rides on this supplier", which is a question
about volume rather than fault.

**Filing frequency inference is marked low confidence.** When there is no supplier master,
a supplier whose GSTR-1 filings land in at most one month per quarter across at least two
quarters is treated as quarterly. Getting this wrong either excuses three months of real
lateness or penalises a supplier for a scheme they are entitled to use, so the inference is
labelled everywhere it affects a score.

**Deemed acceptance counts `NoAction` *and* absence from a supplied log.** Silence is the
commonest form of no action; counting only explicit `NoAction` rows would understate the
finding to the point of hiding it. Periods with no IMS log at all are `unattributed`, not
deemed accepted.

---

## Scope

**Out-of-scope documents are counted and displayed, never deleted.** Blocked 17(5)
credits, reverse charge, ISD, imports, POS-restricted supplies and credit notes are
excluded from ITC at risk and from scoring. Scoring a supplier down over credit nobody was
ever entitled to claim is the fastest way for a tool like this to lose its reader.

**Scope is detected from text markers** in the document-type, nature-of-supply and remarks
columns (see `SCOPE` in `config.ts`), plus the register's own ITC-eligible flag and a
user-editable blocked list. Marker matching is substring and case-insensitive, because no
two exports word these the same way. It will miss a document that carries no marker at all.

---

## Sample data

**The sample uses a pinned reference date of 2026-10-05**, not today's date, so its
figures never drift. Your own uploads are measured against today.

**Sample filing dates are spread across days 8–20 of the month.** Real GSTR-1 is due on
the 11th, but a column in which every day is 12 or less is genuinely indistinguishable
from MM/DD — the engine would correctly refuse to read it, and the one-click demo would
stop at the Data Health prompt. The spread is realistic (late filers exist) and keeps the
demo flowing.

**The "different date format" dirty rows use ISO dates in an otherwise DD/MM column.**
Mixing DD/MM and MM/DD in one column makes it genuinely undecidable, which would block the
demo. ISO is a different format that is still unambiguous, and spreadsheets mix the two
constantly.

---

## Known limitations

- **GSTR-2B JSON is not supported.** Only the Excel download from the portal. A JSON file
  is reported as an explicit, named limitation rather than silently contributing no rows.
- **Saving and reloading a project file is not implemented.** The parsed rows live inside
  the worker and are not passed back across the boundary yet. The UI says so rather than
  writing an incomplete file. Use the CSV exports.
- **No ITC reversal rules.** Rule 37 (180-day payment), Rule 42/43 apportionment and
  re-availment are not modelled.
- **No amendment value tracking.** The latest amendment supersedes earlier versions, but
  the difference between them is not reported as its own figure.
- **Import (IMPG) and ISD sections of GSTR-2B are read and counted but not matched**, since
  they are outside IMS scope.
