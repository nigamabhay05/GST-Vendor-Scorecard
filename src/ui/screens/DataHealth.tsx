import type { AnalysisResult, SlashDateFormatAnswers } from '../../engine/types';
import { scopeReasonLabel } from '../../engine/export/csv';
import { Money, Notice, SectionHeading } from '../components/primitives';
import { EXPLANATIONS } from '../explanations';
import { formatCount } from '../format';

/**
 * Data health, shown before any result and not passable without acknowledgement.
 *
 * This is where the tool proves it can handle real books. Every row that was dropped and
 * every value it could not read is listed with the file and row number it came from, so
 * nothing disappears silently. A figure a user cannot trace is a figure they cannot
 * defend to a client.
 */
export function DataHealth({
  result,
  acknowledged,
  onAcknowledge,
  onResolveDateFormat,
  onContinue,
}: {
  result: AnalysisResult;
  acknowledged: boolean;
  onAcknowledge: (value: boolean) => void;
  onResolveDateFormat: (answers: SlashDateFormatAnswers) => void;
  onContinue: () => void;
}) {
  const health = result.dataHealth;

  const totals = {
    rowsRead: health.files.reduce((sum, file) => sum + file.rowsRead, 0),
    accepted: health.files.reduce((sum, file) => sum + file.rowsAccepted, 0),
    dropped: health.droppedRows.length,
    blank: health.gstinIssues.filter((i) => i.problem === 'blank').length,
    malformed: health.gstinIssues.filter((i) => i.problem === 'malformed').length,
    checkDigit: health.gstinIssues.filter((i) => i.problem === 'check_digit').length,
  };

  return (
    <div className="px-6 py-6">
      <h1 className="text-ink text-[22px] font-semibold tracking-tight">Data health</h1>
      <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
        What was read, what could not be read, and what was excluded. Worth two minutes
        before you rely on anything on the next screen.
      </p>

      {health.blocking && (
        <div className="mt-6">
          <Notice tone="error" title="One date column cannot be read safely">
            Some dates could be either day/month or month/day, and reading them the wrong way
            round would change every delay figure in the report without showing an error.
            Choose the correct reading below.
          </Notice>
        </div>
      )}

      {health.ambiguousColumnMappings.length > 0 && (
        <section className="border-rule mt-6 border-t pt-5">
          <SectionHeading>Columns worth confirming</SectionHeading>
          <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
            More than one column could have filled these fields. The choice below is the
            engine&rsquo;s best reading — check it, because picking the wrong column does
            not produce an error, it produces a clean-looking analysis of the wrong data.
            A register&rsquo;s <span className="num">Voucher No.</span> is its own internal
            numbering; GSTR-2B carries the supplier&rsquo;s{' '}
            <span className="num">Invoice No.</span>, and matching on the wrong one finds
            nothing.
          </p>

          <table className="mt-3 w-full max-w-3xl border-collapse text-[13px]">
            <thead>
              <tr className="border-rule text-ink-muted border-b text-[11px]">
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  File
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Field
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Using
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Also possible
                </th>
              </tr>
            </thead>
            <tbody>
              {health.ambiguousColumnMappings.map((entry) => (
                <tr
                  key={`${entry.fileName}:${entry.field}`}
                  className="border-rule border-b"
                >
                  <td className="num px-3 py-1.5 text-left">{entry.fileName}</td>
                  <td className="px-3 py-1.5">{entry.label}</td>
                  <td className="num text-ink px-3 py-1.5 text-left">{entry.chosenHeader}</td>
                  <td className="num text-ink-muted px-3 py-1.5 text-left">
                    {entry.alternatives.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-ink-muted mt-2 text-[12px]">
            To change one, go back to Files and mapping and pick the column yourself.
          </p>
        </section>
      )}

      {health.ambiguousDateColumns.length > 0 && (
        <section className="border-rule mt-6 border-t pt-5">
          <SectionHeading>Ambiguous date columns</SectionHeading>
          <div className="mt-3 space-y-4">
            {health.ambiguousDateColumns.map((column) => {
              const key = `${column.fileName}::${column.column}`;
              const sample = column.sampleValues[0] ?? '05/04/2026';
              const [a = '05', b = '04', c = '2026'] = sample.split(/[/\-.]/);

              return (
                <div key={key} className="border-rule border p-4">
                  <p className="text-ink text-[13px]">
                    <span className="num">{column.fileName}</span> — column{' '}
                    <span className="font-semibold">{column.column}</span>
                  </p>
                  <p className="text-ink-muted mt-1 text-[12px]">
                    Every value in this column works read either way, for example{' '}
                    <span className="num text-ink">{sample}</span>. Which is it?
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onResolveDateFormat({ [key]: 'DMY' });
                      }}
                      className="border-rule hover:bg-field border px-3 py-1.5 text-[13px]"
                    >
                      Day/month — {a} {monthName(b)} {c}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onResolveDateFormat({ [key]: 'MDY' });
                      }}
                      className="border-rule hover:bg-field border px-3 py-1.5 text-[13px]"
                    >
                      Month/day — {b} {monthName(a)} {c}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading>Files read</SectionHeading>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr className="border-rule text-ink-muted border-b text-[11px]">
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  File
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Type
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Period
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Header row
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Rows read
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Used
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Dropped
                </th>
              </tr>
            </thead>
            <tbody>
              {health.files.map((file) => (
                <tr key={`${file.kind}:${file.fileName}`} className="border-rule border-b">
                  <td className="px-3 py-1.5">{file.fileName}</td>
                  <td className="text-ink-muted px-3 py-1.5">{fileKindLabel(file.kind)}</td>
                  <td className="num px-3 py-1.5 text-left">{file.period ?? '—'}</td>
                  <td className="num px-3 py-1.5">{file.headerRowIndex + 1}</td>
                  <td className="num px-3 py-1.5">{formatCount(file.rowsRead)}</td>
                  <td className="num px-3 py-1.5">{formatCount(file.rowsAccepted)}</td>
                  <td className="num px-3 py-1.5">
                    {file.rowsDropped > 0 ? formatCount(file.rowsDropped) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-rule bg-field border-b font-semibold">
                <td className="px-3 py-1.5" colSpan={4}>
                  Total
                </td>
                <td className="num px-3 py-1.5">{formatCount(totals.rowsRead)}</td>
                <td className="num px-3 py-1.5">{formatCount(totals.accepted)}</td>
                <td className="num px-3 py-1.5">{formatCount(totals.dropped)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading>GSTIN checks</SectionHeading>
        <p className="text-ink-muted mt-1 max-w-2xl text-[12px]">
          A failed check digit is a warning, never a rejection. The row is kept and matched
          as normal — dropping a supplier&rsquo;s data over one bad character would be worse
          than reporting it.
        </p>
        <ul className="mt-3 space-y-1 text-[13px]">
          <li>
            <span className="num text-ink">{formatCount(totals.blank)}</span> blank GSTINs
          </li>
          <li>
            <span className="num text-ink">{formatCount(totals.malformed)}</span> GSTINs that do
            not match the required format
          </li>
          <li>
            <span className="num text-ink">{formatCount(totals.checkDigit)}</span> GSTINs whose
            check digit does not agree
          </li>
        </ul>

        {health.gstinIssues.length > 0 && (
          <details className="mt-3">
            <summary className="text-accent cursor-pointer text-[13px]">
              Show the {formatCount(health.gstinIssues.length)} affected rows
            </summary>
            <div className="mt-2 max-h-64 overflow-y-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-ink-muted border-rule border-b text-[11px]">
                    <th scope="col" className="px-3 py-1 text-left font-normal">
                      File
                    </th>
                    <th scope="col" className="px-3 py-1 text-right font-normal">
                      Row
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-normal">
                      Supplier
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-normal">
                      Value
                    </th>
                    <th scope="col" className="px-3 py-1 text-left font-normal">
                      Problem
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {health.gstinIssues.map((issue, index) => (
                    <tr key={`${issue.fileName}:${String(issue.sourceRow)}:${String(index)}`}>
                      <td className="px-3 py-1">{issue.fileName}</td>
                      <td className="num px-3 py-1">{issue.sourceRow}</td>
                      <td className="px-3 py-1">{issue.supplierName || '—'}</td>
                      <td className="num px-3 py-1 text-left">{issue.value || '(blank)'}</td>
                      <td className="px-3 py-1">{gstinProblemLabel(issue.problem)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading note={{ label: 'exclusions', text: EXPLANATIONS.outOfScope }}>
          Excluded from ITC at risk
        </SectionHeading>
        {health.scopeExclusions.length === 0 ? (
          <p className="text-ink-muted mt-2 text-[13px]">Nothing was excluded.</p>
        ) : (
          <table className="mt-3 w-full max-w-2xl border-collapse text-[13px]">
            <thead>
              <tr className="text-ink-muted border-rule border-b text-[11px]">
                <th scope="col" className="px-3 py-1 text-left font-normal">
                  Reason
                </th>
                <th scope="col" className="px-3 py-1 text-right font-normal">
                  Rows
                </th>
                <th scope="col" className="px-3 py-1 text-right font-normal">
                  Tax
                </th>
              </tr>
            </thead>
            <tbody>
              {health.scopeExclusions.map((exclusion) => (
                <tr key={exclusion.reason} className="border-rule border-b">
                  <td className="px-3 py-1.5">{scopeReasonLabel(exclusion.reason)}</td>
                  <td className="num px-3 py-1.5">{formatCount(exclusion.rows)}</td>
                  <td className="num px-3 py-1.5">
                    <Money value={exclusion.taxValue} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <TwoColumnFindings result={result} />

      <section className="border-rule mt-8 border-t pt-5">
        <label className="flex max-w-2xl items-start gap-3 text-[13px]">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={health.blocking}
            onChange={(event) => {
              onAcknowledge(event.target.checked);
            }}
            className="mt-0.5"
          />
          <span className="text-ink">
            I have read the data health report and understand what was excluded and what
            could not be read.
          </span>
        </label>

        <button
          type="button"
          disabled={!acknowledged || health.blocking}
          onClick={onContinue}
          className="bg-accent mt-4 px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-40"
        >
          Continue to the scorecard
        </button>
      </section>
    </div>
  );
}

function TwoColumnFindings({ result }: { result: AnalysisResult }) {
  const health = result.dataHealth;

  return (
    <section className="border-rule mt-6 grid gap-8 border-t pt-5 lg:grid-cols-2">
      <div>
        <SectionHeading>Invoice number findings</SectionHeading>
        <p className="text-ink-muted mt-1 text-[12px]">
          Normalisation is aggressive by design, so collisions are flagged rather than
          merged: two different documents must never become one.
        </p>

        {health.normalizationCollisions.length === 0 && health.duplicateInvoices.length === 0 ? (
          <p className="text-ink-muted mt-2 text-[13px]">Nothing to report.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-[13px]">
            {health.normalizationCollisions.map((collision) => (
              <li key={`${collision.normalizedKey}:${collision.period}`}>
                <span className="text-flag-amber" aria-hidden="true">
                  ▲{' '}
                </span>
                {collision.supplierName}: {collision.originalInvoiceNumbers.join(' and ')} both
                normalise to <span className="num">{collision.normalizedKey}</span>. Matched on
                value and date instead.
              </li>
            ))}
            {health.duplicateInvoices.map((duplicate) => (
              <li key={`${duplicate.supplierName}:${duplicate.invoiceNumber}`}>
                <span className="text-flag-amber" aria-hidden="true">
                  ▲{' '}
                </span>
                {duplicate.supplierName}: <span className="num">{duplicate.invoiceNumber}</span>{' '}
                appears {formatCount(duplicate.rowIds.length)} times
                {duplicate.identicalValues ? ' with the same value' : ' with different values'}.
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <SectionHeading>Rows dropped and dates unread</SectionHeading>
        {health.droppedRows.length === 0 && health.unparseableDates.length === 0 ? (
          <p className="text-ink-muted mt-2 text-[13px]">Nothing was dropped.</p>
        ) : (
          <div className="mt-3 max-h-64 overflow-y-auto">
            <ul className="space-y-1 text-[12px]">
              {health.droppedRows.map((row, index) => (
                <li key={`${row.fileName}:${String(row.sourceRow)}:${String(index)}`}>
                  <span className="num text-ink-muted">
                    {row.fileName} row {row.sourceRow}
                  </span>{' '}
                  — {row.reason}
                </li>
              ))}
              {health.unparseableDates.map((date, index) => (
                <li key={`d${date.fileName}:${String(date.sourceRow)}:${String(index)}`}>
                  <span className="num text-ink-muted">
                    {date.fileName} row {date.sourceRow}
                  </span>{' '}
                  — could not read {date.column}: &ldquo;{date.value}&rdquo;
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function fileKindLabel(kind: string): string {
  switch (kind) {
    case 'purchaseRegister':
      return 'Purchase register';
    case 'gstr2b':
      return 'GSTR-2B';
    case 'imsLog':
      return 'IMS action log';
    default:
      return 'Supplier master';
  }
}

function gstinProblemLabel(problem: string): string {
  switch (problem) {
    case 'blank':
      return 'Blank';
    case 'malformed':
      return 'Wrong format';
    default:
      return 'Check digit disagrees';
  }
}

function monthName(value: string | undefined): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const index = Number.parseInt(value ?? '', 10) - 1;
  return months[index] ?? '?';
}
