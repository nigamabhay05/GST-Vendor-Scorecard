# Vendor GST Compliance Scorecard

Which suppliers are going to cost you input tax credit next month, how much, and what to
do about it now.

You only get input tax credit if your supplier reports the invoice in their GSTR-1, so it
reaches your GSTR-2B. Now that GSTR-3B is locked to GSTR-2B, a single supplier who files
late blocks your credit and costs you cash. Existing tools do **reconciliation**, which is
backward-looking: it tells you what already broke, a few days before the filing deadline.

This tool is forward-looking. It reads several months of your own history and produces a
supplier scorecard, an attribution of every gap to whoever actually caused it, and a
countdown on credit that is about to expire.

Everything runs in your browser. There is no server.

---

## Privacy

This handles confidential client tax data, and the architecture is built around that
rather than bolted on afterwards.

- **No server, no database, no account, no analytics, no telemetry.**
- **Zero network requests at runtime.** Verified two ways: ESLint refuses to compile
  `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, remote
  imports or any HTTP client library, and the production build ships a
  Content-Security-Policy of `connect-src 'none'` so the browser itself blocks egress
  even from a dependency. Open the network panel and run an analysis: nothing is
  requested beyond the initial HTML, JS, CSS and fonts.
- **Nothing is persisted by the browser.** `localStorage`, `sessionStorage` and
  `indexedDB` are lint errors. The only persistence is a "Save project" button that
  downloads a JSON file to your machine.
- **Fonts are self-hosted** from npm. No CDN, no `fonts.googleapis.com` — a request to a
  font CDN would leak the fact that this page was opened.

---

## Running it

```bash
npm install
npm run dev
```

Then click **Load sample data**. Nothing needs configuring.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Vitest over the engine (199 tests) |
| `npm run verify` | Runs the whole engine over the sample files **in Node, with no browser**, and prints the figures |
| `npm run fixtures` | Regenerates the sample dataset |
| `npm run lint` | ESLint, including the privacy and layering rules |
| `npm run build` | Lint, then typecheck, then build. A network call fails the build |

`npm run verify` is the useful one when changing a rule: it prints every headline figure
from the command line, so a change in behaviour is visible before any screen can hide it.

---

## Inputs

Files for one or more monthly periods. Three periods is the minimum that produces a score;
six to twelve is where the tool earns its keep.

| File | Required | Notes |
|---|---|---|
| **Purchase register** | Yes | CSV or Excel, one per period. Tally-style exports with title rows, merged cells and grand totals are handled |
| **GSTR-2B** | Yes | The **Excel** download from the portal, one per period. JSON is not supported yet and says so |
| **Supplier master** | No | Contact details and declared filing frequency. Turns the report into a workflow |
| **IMS action log** | No | The attribution layer. Without it every gap is "not attributed" and the interface says so |

Column headers are auto-detected against a synonym list and then shown to you for
correction, with a live preview of the first rows. A fuzzy match is labelled as a guess.

The critical field in GSTR-2B, beyond the obvious ones, is the **supplier's GSTR-1 filing
date**. It is the only place a buyer can see *when* their supplier actually filed without
an API or a subscription, and it is what makes this tool forward-looking rather than
another reconciliation report.

---

## How every number is calculated

Every threshold, weight and tolerance below lives in
[`src/engine/config.ts`](src/engine/config.ts) with a comment explaining the default.
Assumptions and judgement calls are in [ASSUMPTIONS.md](ASSUMPTIONS.md).

### Matching

Documents are matched **deterministically, in strict tier order, and strictly one-to-one**.
Once a book row or a 2B row is consumed it cannot match again — otherwise one 2B row could
satisfy three book rows and the report would claim credit that does not exist. Every tier
runs across the whole dataset before the next begins, so a certain tier-1 match is never
lost to a speculative tier-5 one elsewhere. Both sides are sorted before every tier, so the
same input always produces byte-identical output.

| Tier | Rule | Shown as | Counts as |
|---|---|---|---|
| 1 | GSTIN + normalised invoice no + total tax within ₹1 | Matched | Credit received |
| 2 | GSTIN + normalised invoice no, value differs | Value mismatch | 2B value received, shortfall at risk |
| 3 | GSTIN + taxable value + invoice date within ±3 days | Invoice number mismatch | Credit received |
| 4 | PAN + invoice no + value, different GSTIN | GSTIN / state mismatch | Needs correction — neither |
| 5 | GSTIN + value + edit distance ≤ 2 on invoice no | Probable match, review | Needs correction — neither |
| — | Book row with no counterpart | Missing in GSTR-2B | At risk |
| — | 2B row with no counterpart | Missing in books | Neither |

Tiers 4 and 5 deliberately count in neither total: the credit exists but is not usable as
it stands, so counting it either way would overstate a figure. It is reported as its own
category with its own value.

**Invoice numbers** are normalised by uppercasing, splitting into letter and digit runs,
stripping leading zeros from each numeric run, and discarding everything else — so
`INV/2026/001` and `INV-2026-1` both become `INV20261`. If that collapses two *different*
invoices from one supplier in one period onto the same key, they are **not** merged: both
are flagged in Data Health and matched on value and date instead.

**Tax head mismatch** — books showing CGST+SGST where 2B shows IGST, or the reverse — is
its own flag, not a gap. The credit exists, under the wrong head.

**Amendments** supersede the document they amend; the latest one wins and earlier versions
are excluded from matching.

### Delay

Delay is the months between the period an invoice should have appeared in (from its
invoice date) and the period it actually appeared in. Scoring uses **delay beyond what the
supplier is allowed**: a quarterly QRMP filer who files within their own quarter has a
delay of zero, however many months after the invoice date the credit arrived.

### Scope exclusions

Counted and displayed separately, but excluded from ITC at risk and from scoring:

- Credits blocked under **section 17(5)** (from the register's flag, plus a user-editable list)
- **Reverse charge, ISD, import of services, POS-restricted** supplies
- **Credit notes** (tracked separately)
- Anything the register itself marks ITC-ineligible

Scoring a supplier down over credit nobody was ever entitled to claim is the single
commonest way a tool like this loses the confidence of the person using it.

### Attribution

Every gap is classified into exactly one of six causes:

| Cause | Whose | Affects score |
|---|---|---|
| Supplier never reported | Supplier | Yes |
| Supplier reported late | Supplier | Yes |
| You rejected it in IMS | Yours | No |
| You kept it pending in IMS | Yours | No |
| Deemed accepted | — | No |
| Not attributed | — | No |

The two recipient causes are your own internal control finding. A missing invoice is not
evidence against a supplier until you know your own team did not reject it — this is the
difference between a report that blames suppliers and one that tells the truth. With no
IMS log, everything is "not attributed" and the interface says so rather than guessing.

### Supplier score

Out of 100, over the last **6** periods, weighted:

| Component | Weight | Meaning |
|---|---|---|
| Match rate | 45 | Value received on time ÷ total in-scope value |
| Average delay | 25 | Value-weighted months late, beyond what is allowed |
| Volatility | 15 | Standard deviation of the monthly match rate |
| Dispute rate | 15 | Value in supplier-caused gaps, plus credit note issues |

**OK ≥ 80 · Watch 50–79 · At risk < 50.**

Credit you rejected or kept pending is excluded from the match-rate denominator — it is
your decision, not the supplier's failure.

A supplier with fewer than **3** periods of data gets **"Insufficient history"** and no
score at all. One bad month is not a pattern, and a confident red flag drawn from it would
send someone to make a phone call they should not make.

### Expected cash loss

`ITC at risk × (1 − historical recovery rate)`

A gap counts as recovered if the invoice appears in any later period you loaded. The rate
is the supplier's own where at least 5 of their past gaps have resolved, and the whole
dataset's otherwise — **and the interface always says which was used**. The known
pessimistic bias is documented in ASSUMPTIONS.md and shown in the tooltip.

### Pending ageing and the 30 November deadline

Pending IMS records are bucketed at 0–30 / 31–60 / 61–90 / 90+ days, and each carries a
countdown to **30 November following its financial year end** — the date after which the
credit cannot be claimed at all. Anything within 60 days of that is red. After it, the
credit is not late; it is gone.

---

## Architecture

The processing layer is built as a real backend even though there is no server: pure
TypeScript, no React, no DOM, fully unit-tested, runnable from a Node script. It runs in a
Web Worker so the UI never freezes.

```
src/engine/      the "backend" — pure, testable, no React, no DOM
  types.ts       single source of truth for every domain type
  config.ts      every tunable constant, nowhere else
  parse/         CSV and Excel readers, one parser per input kind
  validate/      GSTIN, dates, and the Data Health report
  normalize/     invoice numbers, money, periods
  match/         tiers.ts (one predicate per tier), pipeline.ts
  analyse/       attribution, scoring, ageing, exposure
  export/        CSV, follow-up emails, project file
  index.ts       runAnalysis(inputs) -> AnalysisResult
  worker.ts
src/ui/          screens and components
src/fixtures/    seeded generator and the committed sample dataset
```

Two architectural claims are **enforced by ESLint rather than documented and hoped for**:

- `src/engine/**` cannot import React, the UI, or touch `document` or `window`. If it
  could, it would eventually stop being runnable in Node and `npm run verify` would
  quietly become a lie.
- `src/ui/**` cannot import the engine's parsing, matching, analysis or normalisation
  modules. It may import types, config, the pure export builders and the worker hook. This
  is how "the UI never computes a business number" gets teeth.

If a number appears on screen, it is a field of the `AnalysisResult` the engine returned.

---

## Sample data

`src/fixtures/sample/` holds 25 files — 25 suppliers, 8 periods, 382 documents — generated
deterministically from a fixed seed by `npm run fixtures`. They are the same file formats a
real user would upload, and you can open them.

The dataset deliberately contains the cases the tool exists to find: a chronic late filer;
a supplier who looks terrible until the IMS log reveals the buyer rejected everything; a
QRMP filer who must score green; a supplier reporting under the wrong state GSTIN; another
quoting the buyer's GSTIN wrongly; a supplier clean for months who collapses in March;
invoice number format drift; two forgotten pending invoices ageing towards 30 November; a
rejected credit note; blocked 17(5) purchases; and deliberately dirty rows — three blank
GSTINs, one broken check digit, mixed date formats, and amounts stored as text with commas.

Because the app makes no network requests, the sample cannot be fetched at runtime. The
generator also emits `src/fixtures/sampleBundle.ts`, which embeds the same bytes so
"Load sample data" runs the identical files through the identical parsers.

The sample is labelled as generated demonstration data everywhere it appears.

---

## Testing

```bash
npm test
```

199 tests over the engine, including: GSTIN checksum against known-valid GSTINs; invoice
normalisation and the collision case that must **not** merge; money parsing (`₹1,44,000.00`,
`(1,200)`, text, blank); date parsing (Excel serials, three string formats, and the
ambiguous case that must raise a prompt rather than guess); every match tier in isolation;
one-to-one enforcement; determinism; scoring (insufficient history, QRMP not penalised,
blocked credits excluded); attribution (a buyer-rejected invoice attributed to the
recipient, not the supplier); the 30 November boundary either side; and an end-to-end run
over the sample with a snapshot on the headline KPIs plus an assertion for each seeded
pattern.

---

## Known limitations

Listed honestly rather than discovered later. See ASSUMPTIONS.md for the full set.

- GSTR-2B **JSON is not supported** — Excel only. A JSON file is reported as a named
  limitation, not silently ignored.
- **Saving and reloading a project file is not implemented.** The parsed rows are not yet
  passed back from the worker. The UI says so; use the CSV exports.
- No ITC reversal rules (Rule 37, Rule 42/43).
- The section 16(4) deadline does not model the "or annual return, whichever earlier" limb,
  so it can be optimistic.
- One buyer GSTIN per project.
- Responsive down to tablet width; the supplier table scrolls horizontally with a frozen
  first column rather than collapsing into cards.

---

## Stack

Vite · React · TypeScript (strict, `noUncheckedIndexedAccess`) · Tailwind · PapaParse ·
SheetJS · Recharts · Vitest. Static build, deployable to any static host.

SheetJS is installed from the vendor's own distribution rather than the npm mirror, which
is frozen at 0.18.5 and carries two known CVEs.
