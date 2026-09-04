import type { AnalysisResult } from '../../engine/types';
import { EXPLANATIONS, KPI_NOTES } from '../explanations';
import { formatCount, formatInrCompact, formatInrExact, formatPercent } from '../format';
import { InfoNote } from './primitives';

/**
 * The headline strip.
 *
 * One ruled band divided by vertical hairlines, not four floating cards. The figures are
 * the largest thing on the page and every one of them carries the rule that produced it.
 */
export function KpiBand({ result }: { result: AnalysisResult }) {
  const atRisk = formatInrCompact(result.kpis.totalItcAtRisk);
  const loss = formatInrCompact(result.kpis.expectedCashLoss);

  const items = [
    {
      key: 'atRisk',
      label: 'ITC at risk',
      value: atRisk.display,
      exact: atRisk.exact,
      sections: KPI_NOTES.itcAtRisk,
      tone: 'ink' as const,
    },
    {
      key: 'loss',
      label: 'Expected cash loss',
      value: loss.display,
      exact: loss.exact,
      sections: KPI_NOTES.expectedCashLoss,
      tone: 'red' as const,
    },
    {
      key: 'red',
      label: 'Suppliers at risk',
      value: formatCount(result.kpis.redSupplierCount),
      exact: `${formatCount(result.kpis.redSupplierCount)} of ${formatCount(result.suppliers.length)} suppliers`,
      sections: KPI_NOTES.redSuppliers,
      tone: 'ink' as const,
    },
    {
      key: 'deemed',
      label: 'Records deemed accepted',
      value: formatPercent(result.kpis.deemedAcceptedShare, 1),
      exact: `${formatCount(result.kpis.deemedAcceptedCount)} records`,
      sections: undefined,
      note: EXPLANATIONS.deemedAccepted,
      tone: 'ink' as const,
    },
  ];

  return (
    <section aria-label="Headline figures" className="border-rule bg-field border-y">
      <dl className="grid grid-cols-2 lg:grid-cols-4">
        {items.map((item, index) => (
          <div
            key={item.key}
            className={[
              'px-6 py-5',
              index > 0 ? 'lg:border-rule lg:border-l' : '',
              index % 2 === 1 ? 'border-rule border-l lg:border-l' : '',
              index >= 2 ? 'border-rule border-t lg:border-t-0' : '',
            ].join(' ')}
          >
            <dd
              className={`num text-left text-[32px] leading-none ${
                item.tone === 'red' ? 'text-flag-red' : 'text-ink'
              }`}
              title={item.exact}
              aria-label={item.exact}
            >
              {item.value}
            </dd>
            <dt className="text-ink-muted mt-2 flex items-center text-[11px]">
              {item.label}
              {item.sections ? (
                <InfoNote label={item.label} sections={item.sections} />
              ) : (
                <InfoNote label={item.label} text={item.note} />
              )}
            </dt>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The one-line context under the band: what was read, and over what window. */
export function AnalysisSummaryLine({ result }: { result: AnalysisResult }) {
  const first = result.meta.periods[0];
  const last = result.meta.periods[result.meta.periods.length - 1];

  return (
    <p className="text-ink-muted px-6 py-3 text-[12px]">
      {formatCount(result.matches.length)} documents across{' '}
      {formatCount(result.meta.periods.length)} periods
      {first && last ? `, ${first} to ${last}` : ''}. Scored over the last{' '}
      {formatCount(result.meta.scoringPeriods.length)}. Total in-scope credit{' '}
      <span className="num text-ink" title={formatInrExact(result.kpis.totalInScopeItc)}>
        {formatInrCompact(result.kpis.totalInScopeItc).display}
      </span>
      . Figures as at {result.meta.asOf}.
    </p>
  );
}
