import type { AnalysisResult } from '../../engine/types';
import { EXPLANATIONS, KPI_NOTES } from '../explanations';
import {
  formatCount,
  formatInrCompact,
  formatInrExact,
  formatPercent,
  formatPeriodRange,
} from '../format';
import { InfoNote } from './primitives';

interface KpiItem {
  key: string;
  label: string;
  value: string;
  /** Optional second line under the figure: the denominator, or why there is none. */
  sub?: string;
  exact: string;
  sections?: readonly { label: string; body: string }[];
  note?: string;
  tone: 'ink' | 'red';
}

/**
 * The headline strip.
 *
 * One ruled band divided by vertical hairlines, not four floating cards. The figures are
 * the largest thing on the page and every one of them carries the rule that produced it.
 */
export function KpiBand({ result }: { result: AnalysisResult }) {
  const atRisk = formatInrCompact(result.kpis.totalItcAtRisk);
  const loss = formatInrCompact(result.kpis.expectedCashLoss);
  const deemed = result.deemedAcceptance;

  const items: KpiItem[] = [
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
      label: 'Suppliers needing attention',
      value: formatCount(result.kpis.suppliersNeedingAttention),
      exact:
        `${formatCount(result.kpis.redSupplierCount)} at risk, ` +
        `${formatCount(result.kpis.userActionSupplierCount)} awaiting your action, ` +
        `of ${formatCount(result.suppliers.length)} suppliers`,
      sections: KPI_NOTES.redSuppliers,
      tone: 'ink' as const,
    },
    {
      key: 'deemed',
      label: 'Records deemed accepted',
      /*
       * Without an IMS log there is nothing to deem: no log means no No Action rows, and
       * a percentage of zero would read as a clean result rather than as a missing file.
       */
      value: deemed.imsLogSupplied ? formatPercent(result.kpis.deemedAcceptedShare, 1) : '--',
      // The denominator, on the tile itself. A share whose base is unstated cannot be
      // checked against the user's own file, which is the only test that matters here.
      sub: deemed.imsLogSupplied
        ? `${formatCount(result.kpis.deemedAcceptedCount)} of ` +
          `${formatCount(deemed.recordsConsidered)} records that reached GSTR-2B`
        : 'No IMS log supplied',
      exact: deemed.imsLogSupplied
        ? `${formatCount(result.kpis.deemedAcceptedCount)} records marked No Action in IMS, ` +
          `out of ${formatCount(deemed.recordsConsidered)} in-scope records found in GSTR-2B`
        : 'Upload an IMS action log to measure this',
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
            {item.sub ? (
              <p className="text-ink-muted num mt-2 text-[11px]">{item.sub}</p>
            ) : null}
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
  const counts = result.meta.documentCounts;

  return (
    <p className="text-ink-muted px-6 py-3 text-[12px]">
      {/*
        The line count matches neither input file on its own: a matched pair collapses to
        one line, credit notes are held back from matching, and a 2B row with no register
        counterpart adds one. Stated in full, because a total that ties to nothing the
        user can see in their own files reads as an arithmetic error in the tool.
      */}
      {formatCount(counts.registerRows)} register rows and{' '}
      {formatCount(counts.portalRows)} GSTR-2B rows across{' '}
      {formatCount(result.meta.periods.length)} periods,{' '}
      {formatPeriodRange(result.meta.periods)}, giving{' '}
      {formatCount(counts.total)} document lines:{' '}
      {formatCount(counts.fromRegister)} from your register
      {counts.registerRowsNotMatched > 0
        ? ` (${formatCount(counts.registerRowsNotMatched)} credit ` +
          `${counts.registerRowsNotMatched === 1 ? 'note' : 'notes'} tracked separately)`
        : ''}
      {counts.portalOnly > 0
        ? `, plus ${formatCount(counts.portalOnly)} found only in GSTR-2B`
        : ''}
      . Scored over the last {formatCount(result.meta.scoringPeriods.length)} periods.
      Total in-scope credit{' '}
      <span className="num text-ink" title={formatInrExact(result.kpis.totalInScopeItc)}>
        {formatInrCompact(result.kpis.totalInScopeItc).display}
      </span>
      . Figures as at {result.meta.asOf}.
    </p>
  );
}
