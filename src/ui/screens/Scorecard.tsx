import { useMemo, useState } from 'react';
import type { AnalysisResult, SupplierFlag, SupplierScorecardEntry } from '../../engine/types';
import { AnalysisSummaryLine, KpiBand } from '../components/KpiBand';
import { FlagChip, InfoNote, Money, Notice } from '../components/primitives';
import { EXPLANATIONS } from '../explanations';
import { formatCount, formatMonths, formatPercent } from '../format';

/**
 * The main screen.
 *
 * The measure of this table is that a partner can read it in ten seconds and know which
 * supplier to call. So it is sorted worst-first by default, the money is in tabular
 * figures aligned down the column, and the suggested action is a sentence rather than a
 * code.
 */

type SortKey =
  | 'name'
  | 'score'
  | 'matchRate'
  | 'avgDelay'
  | 'itcAtRisk'
  | 'declinedHeld'
  | 'expectedCashLoss'
  | 'concentration';

const FLAG_FILTERS: Array<{ id: 'all' | SupplierFlag; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'red', label: 'At risk' },
  { id: 'amber', label: 'Watch' },
  { id: 'green', label: 'OK' },
  { id: 'insufficient_history', label: 'Insufficient history' },
];

export function Scorecard({
  result,
  onOpenSupplier,
}: {
  result: AnalysisResult;
  onOpenSupplier: (key: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState<'all' | SupplierFlag>('all');
  const [sortKey, setSortKey] = useState<SortKey>('expectedCashLoss');
  const [ascending, setAscending] = useState(false);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();

    const filtered = result.suppliers.filter((supplier) => {
      if (flagFilter !== 'all' && supplier.flag !== flagFilter) return false;
      if (needle === '') return true;
      return (
        supplier.name.toLowerCase().includes(needle) ||
        (supplier.gstin ?? '').toLowerCase().includes(needle)
      );
    });

    const valueOf = (supplier: SupplierScorecardEntry): number | string => {
      switch (sortKey) {
        case 'name':
          return supplier.name.toLowerCase();
        case 'score':
          return supplier.score ?? -1;
        case 'matchRate':
          return supplier.components.matchRate;
        case 'avgDelay':
          return supplier.components.avgDelayMonths;
        case 'itcAtRisk':
          return supplier.itcAtRisk;
        case 'declinedHeld':
          return supplier.declinedValue + supplier.heldValue;
        case 'concentration':
          return supplier.concentration;
        default:
          return supplier.expectedCashLoss;
      }
    };

    return [...filtered].sort((a, b) => {
      const left = valueOf(a);
      const right = valueOf(b);
      const comparison =
        typeof left === 'string' && typeof right === 'string'
          ? left.localeCompare(right)
          : Number(left) - Number(right);
      return ascending ? comparison : -comparison;
    });
  }, [result.suppliers, search, flagFilter, sortKey, ascending]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setAscending((wasAscending) => !wasAscending);
      return;
    }
    setSortKey(key);
    setAscending(key === 'name');
  };

  const header = (key: SortKey, label: string, numeric: boolean, note?: string) => (
    <th
      scope="col"
      aria-sort={sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'}
      className={`border-rule bg-field text-ink-muted sticky top-0 z-10 border-b px-3 py-2 text-[11px] font-normal ${
        numeric ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        onClick={() => {
          toggleSort(key);
        }}
        className="hover:text-accent inline-flex items-center gap-1"
      >
        {label}
        <span aria-hidden="true" className="text-[9px]">
          {sortKey === key ? (ascending ? '▲' : '▼') : ''}
        </span>
      </button>
      {note && <InfoNote label={label} text={note} />}
    </th>
  );

  return (
    <div>
      <div className="px-6 pt-6">
        <h1 className="text-ink text-[22px] font-semibold tracking-tight">Supplier scorecard</h1>
        {result.meta.isSampleData && (
          <p className="text-ink-muted mt-1 text-[12px]">
            Generated demonstration data — not real client data.
          </p>
        )}
      </div>

      <div className="mt-5">
        <KpiBand result={result} />
        <AnalysisSummaryLine result={result} />
      </div>

      {result.notImplemented.length > 0 && (
        <div className="px-6 pb-4">
          <Notice tone="warning" title="Not everything in your files was used">
            <ul className="list-disc pl-5">
              {result.notImplemented.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="border-rule flex flex-wrap items-center gap-4 border-y px-6 py-3">
        <label className="text-ink-muted flex items-center gap-2 text-[12px]">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Supplier or GSTIN"
            className="border-rule text-ink w-56 border px-2 py-1 text-[13px]"
          />
        </label>

        <div className="flex items-center gap-1" role="group" aria-label="Filter by flag">
          {FLAG_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              aria-pressed={flagFilter === filter.id}
              onClick={() => {
                setFlagFilter(filter.id);
              }}
              className={`border px-2 py-1 text-[12px] ${
                flagFilter === filter.id
                  ? 'border-accent text-accent font-semibold'
                  : 'border-rule text-ink-muted hover:bg-field'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <span className="text-ink-muted ml-auto text-[12px]">
          {formatCount(rows.length)} of {formatCount(result.suppliers.length)} suppliers
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="px-6 py-10">
          <Notice title="No suppliers match this filter">
            Clear the search box, or choose All, to see the full list again.
          </Notice>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse text-[13px]">
            <caption className="sr-only">
              Suppliers with their compliance score, credit at risk and suggested action
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  aria-sort={sortKey === 'name' ? (ascending ? 'ascending' : 'descending') : 'none'}
                  className="border-rule bg-field text-ink-muted sticky top-0 left-0 z-20 border-r border-b px-3 py-2 text-left text-[11px] font-normal"
                >
                  <button
                    type="button"
                    onClick={() => {
                      toggleSort('name');
                    }}
                    className="hover:text-accent"
                  >
                    Supplier
                  </button>
                </th>
                {header('score', 'Score', true, EXPLANATIONS.score)}
                <th
                  scope="col"
                  className="border-rule bg-field text-ink-muted sticky top-0 z-10 border-b px-3 py-2 text-left text-[11px] font-normal"
                >
                  Flag
                </th>
                {header('matchRate', 'Match rate', true, EXPLANATIONS.matchRate)}
                {header('avgDelay', 'Avg delay (mo)', true, EXPLANATIONS.avgDelayMonths)}
                {header('itcAtRisk', 'ITC at risk', true, EXPLANATIONS.itcAtRisk)}
                {header('declinedHeld', 'Declined / held', true, EXPLANATIONS.declinedHeld)}
                {header(
                  'expectedCashLoss',
                  'Expected cash loss',
                  true,
                  `${EXPLANATIONS.expectedCashLoss} ${EXPLANATIONS.recoveryBias}`,
                )}
                {header('concentration', 'Share of ITC', true, EXPLANATIONS.concentration)}
                <th
                  scope="col"
                  className="border-rule bg-field text-ink-muted sticky top-0 z-10 border-b px-3 py-2 text-left text-[11px] font-normal"
                >
                  Suggested action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((supplier) => (
                <tr key={supplier.key} className="border-rule hover:bg-field border-b">
                  <th
                    scope="row"
                    className="border-rule bg-sheet sticky left-0 z-10 border-r px-3 py-2 text-left font-normal"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onOpenSupplier(supplier.key);
                      }}
                      className="text-accent text-left hover:underline"
                    >
                      {supplier.name}
                    </button>
                    <div className="num text-ink-muted mt-0.5 text-left text-[11px]">
                      {supplier.gstin ?? 'No GSTIN'}
                    </div>
                  </th>

                  <td className="num px-3 py-2">
                    {supplier.score === null ? (
                      <span className="text-ink-muted" title={EXPLANATIONS.insufficientHistory}>
                        —
                      </span>
                    ) : (
                      supplier.score
                    )}
                  </td>

                  <td className="px-3 py-2">
                    <FlagChip flag={supplier.flag} />
                  </td>

                  <td className="num px-3 py-2">{formatPercent(supplier.components.matchRate)}</td>
                  <td className="num px-3 py-2">
                    {formatMonths(supplier.components.avgDelayMonths)}
                  </td>
                  <td className="num px-3 py-2">
                    <Money value={supplier.itcAtRisk} />
                  </td>
                  <td className="num px-3 py-2">
                    {supplier.declinedValue + supplier.heldValue > 0 ? (
                      <Money value={supplier.declinedValue + supplier.heldValue} />
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="num px-3 py-2">
                    <Money value={supplier.expectedCashLoss} />
                    <span className="text-ink-muted ml-1 text-[10px]">
                      {supplier.recoveryBasis.source === 'supplier' ? 'own' : 'global'}
                    </span>
                  </td>
                  <td className="num px-3 py-2">{formatPercent(supplier.concentration)}</td>
                  <td className="text-ink-muted max-w-[26rem] px-3 py-2">
                    {supplier.suggestedAction}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
