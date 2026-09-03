import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { attributionLabel, scopeReasonLabel, statusLabel } from '../../engine/export/csv';
import type { AnalysisResult } from '../../engine/types';
import { FlagChip, Money, Notice, SectionHeading, Stat } from '../components/primitives';
import { EXPLANATIONS } from '../explanations';
import { formatDate, formatMonths, formatPercent, formatPeriod } from '../format';

/**
 * One supplier, in enough detail to defend every figure on the scorecard row above it.
 */
export function SupplierDetail({
  result,
  supplierKey,
  onBack,
}: {
  result: AnalysisResult;
  supplierKey: string;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const supplier = result.suppliers.find((entry) => entry.key === supplierKey);

  const documents = useMemo(
    () =>
      result.matches
        .filter((match) => supplier?.matchResultIds.includes(match.id))
        .sort((a, b) => (a.invoiceDate ?? '').localeCompare(b.invoiceDate ?? '')),
    [result.matches, supplier],
  );

  const email = result.followUpEmails.find((entry) => entry.supplierKey === supplierKey);

  const chartData = useMemo(
    () =>
      (supplier?.monthlyMatchRate ?? []).map((entry) => ({
        period: formatPeriod(entry.period),
        matchRate: entry.matchRate === null ? null : Math.round(entry.matchRate * 100),
      })),
    [supplier],
  );

  if (!supplier) {
    return (
      <div className="px-6 py-6">
        <Notice title="That supplier is no longer in the results">
          The analysis may have been re-run. Go back to the scorecard and choose a supplier
          from the list.
        </Notice>
        <button type="button" onClick={onBack} className="text-accent mt-4 text-[13px] underline">
          Back to the scorecard
        </button>
      </div>
    );
  }

  return (
    <div className="px-6 py-6">
      <button type="button" onClick={onBack} className="text-accent text-[13px] hover:underline">
        ← Scorecard
      </button>

      <div className="mt-3 flex flex-wrap items-baseline gap-4">
        <h1 className="text-ink text-[22px] font-semibold tracking-tight">{supplier.name}</h1>
        <FlagChip flag={supplier.flag} />
        <span className="num text-ink-muted text-[12px]">{supplier.gstin ?? 'No GSTIN'}</span>
      </div>

      {supplier.filingFrequencySource !== 'master' && (
        <p className="text-ink-muted mt-2 text-[12px]">
          Filing frequency ({supplier.filingFrequency}) was{' '}
          {supplier.filingFrequencySource === 'inferred'
            ? 'inferred from the filing dates in GSTR-2B'
            : 'assumed'}
          , not taken from a supplier master. Confidence: {supplier.filingFrequencyConfidence}.
        </p>
      )}

      <section className="border-rule mt-5 grid gap-6 border-y py-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Score" note={{ label: 'score', text: EXPLANATIONS.score }}>
          <span className="num">{supplier.score ?? '—'}</span>
          {supplier.score === null && (
            <span className="text-ink-muted ml-2 text-[11px]">
              {EXPLANATIONS.insufficientHistory}
            </span>
          )}
        </Stat>
        <Stat label="Match rate" note={{ label: 'match rate', text: EXPLANATIONS.matchRate }}>
          <span className="num">{formatPercent(supplier.components.matchRate)}</span>
        </Stat>
        <Stat label="Avg delay" note={{ label: 'delay', text: EXPLANATIONS.avgDelayMonths }}>
          <span className="num">{formatMonths(supplier.components.avgDelayMonths)} mo</span>
        </Stat>
        <Stat label="Volatility" note={{ label: 'volatility', text: EXPLANATIONS.volatility }}>
          <span className="num">{supplier.components.volatility.toFixed(2)}</span>
        </Stat>
        <Stat label="ITC at risk" note={{ label: 'ITC at risk', text: EXPLANATIONS.itcAtRisk }}>
          <Money value={supplier.itcAtRisk} />
        </Stat>
        <Stat
          label="Expected cash loss"
          note={{
            label: 'expected cash loss',
            text: `${EXPLANATIONS.expectedCashLoss} ${EXPLANATIONS.recoveryBias}`,
          }}
        >
          <Money value={supplier.expectedCashLoss} />
          <div className="text-ink-muted mt-0.5 text-[11px]">
            {formatPercent(supplier.recoveryBasis.rate)} recovery,{' '}
            {supplier.recoveryBasis.source === 'supplier'
              ? `this supplier’s own record (${String(supplier.recoveryBasis.sampleSize)} resolved gaps)`
              : `dataset average (${String(supplier.recoveryBasis.sampleSize)} resolved gaps)`}
          </div>
        </Stat>
      </section>

      {supplier.needsCorrectionValue > 0 && (
        <div className="mt-5">
          <Notice tone="warning" title="Some credit was found but is not usable as it stands">
            <Money value={supplier.needsCorrectionValue} /> was matched at tier 4 or 5.{' '}
            {EXPLANATIONS.needsCorrection}
          </Notice>
        </div>
      )}

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading>Suggested action</SectionHeading>
        <p className="text-ink mt-2 max-w-3xl text-[14px]">{supplier.suggestedAction}</p>
        {supplier.contact && (
          <p className="text-ink-muted mt-2 text-[12px]">
            {supplier.contact.contactPerson ?? 'No contact name'}
            {supplier.contact.email ? ` · ${supplier.contact.email}` : ''}
            {supplier.contact.phone ? ` · ${supplier.contact.phone}` : ''}
            {supplier.contact.paymentTermsDays !== null
              ? ` · ${String(supplier.contact.paymentTermsDays)} day terms`
              : ''}
          </p>
        )}
      </section>

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading>Monthly match rate</SectionHeading>
        <p className="text-ink-muted mt-1 text-[12px]">
          Periods where this supplier had no in-scope purchases are left empty rather than
          drawn as zero.
        </p>
        <div className="mt-3 h-48 max-w-2xl">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
              <CartesianGrid stroke="var(--color-rule)" vertical={false} />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 11, fill: 'var(--color-ink-muted)' }}
                stroke="var(--color-rule)"
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: 'var(--color-ink-muted)' }}
                stroke="var(--color-rule)"
                unit="%"
              />
              <Tooltip
                formatter={(value) => [typeof value === 'number' ? `${String(value)}%` : '—', 'Match rate']}
                contentStyle={{
                  border: '1px solid var(--color-rule)',
                  borderRadius: 0,
                  fontSize: 12,
                }}
              />
              <Line
                type="linear"
                dataKey="matchRate"
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading note={{ label: 'match tiers', text: EXPLANATIONS.matchTiers }}>
          Documents
        </SectionHeading>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-[13px]">
            <thead>
              <tr className="border-rule text-ink-muted border-b text-[11px]">
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Invoice
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Date
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Tier
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Expected
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Arrived
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Received
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  At risk
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Attribution
                </th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={document.id} className="border-rule border-b">
                  <td className="num px-3 py-1.5 text-left">{document.invoiceNumber}</td>
                  <td className="num px-3 py-1.5 text-left">{formatDate(document.invoiceDate)}</td>
                  <td className="px-3 py-1.5">
                    {statusLabel(document.status)}
                    {document.taxHeadMismatch && (
                      <span className="text-flag-amber ml-1 text-[11px]" title={EXPLANATIONS.taxHeadMismatch}>
                        ▲ tax head
                      </span>
                    )}
                    {document.notYetDue && (
                      <span className="text-ink-muted ml-1 text-[11px]" title={EXPLANATIONS.notYetDue}>
                        not yet due
                      </span>
                    )}
                    {!document.inScope && (
                      <span className="text-ink-muted ml-1 text-[11px]">
                        {scopeReasonLabel(document.scopeReason)}
                      </span>
                    )}
                  </td>
                  <td className="num px-3 py-1.5">{document.tier ?? '—'}</td>
                  <td className="num px-3 py-1.5 text-left">
                    {formatPeriod(document.expectedPeriod)}
                  </td>
                  <td className="num px-3 py-1.5 text-left">
                    {formatPeriod(document.actualPeriod)}
                    {document.delayMonths !== null && document.delayMonths > 0 && (
                      <span className="text-ink-muted ml-1 text-[11px]">
                        +{document.delayMonths}
                      </span>
                    )}
                  </td>
                  <td className="num px-3 py-1.5">
                    <Money value={document.taxReceived} />
                  </td>
                  <td className="num px-3 py-1.5">
                    <Money value={document.taxAtRisk} />
                  </td>
                  <td className="text-ink-muted px-3 py-1.5">
                    {attributionLabel(document.attribution)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading>Follow-up email</SectionHeading>
        {email ? (
          <div className="mt-3 max-w-3xl">
            <div className="text-ink-muted text-[12px]">
              To: {email.to ?? 'no email address in the supplier master'}
            </div>
            <div className="text-ink mt-1 text-[13px] font-semibold">{email.subject}</div>
            <pre className="border-rule bg-field text-ink mt-2 max-h-80 overflow-auto border p-4 text-[12px] whitespace-pre-wrap">
              {email.body}
            </pre>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(`${email.subject}\n\n${email.body}`).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => {
                      setCopied(false);
                    }, 2000);
                  },
                  () => {
                    setCopied(false);
                  },
                );
              }}
              className="border-rule hover:bg-field mt-3 border px-3 py-1.5 text-[13px]"
            >
              {copied ? 'Copied' : 'Copy email'}
            </button>
          </div>
        ) : (
          <p className="text-ink-muted mt-2 max-w-2xl text-[13px]">
            No email was generated. Either there is nothing at risk with this supplier, or the
            gap is one your own team caused in IMS — in which case chasing the supplier would
            be the wrong move.
          </p>
        )}
      </section>
    </div>
  );
}
