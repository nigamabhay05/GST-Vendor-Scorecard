import { attributionLabel } from '../../engine/export/csv';
import type { AnalysisResult } from '../../engine/types';
import { DeadlineChip, Money, Notice, SectionHeading } from '../components/primitives';
import { EXPLANATIONS } from '../explanations';
import { formatCount, formatDate, formatDays, formatPercent } from '../format';

/**
 * The three things only this tool surfaces.
 *
 * A reconciliation report can tell you what is missing. It cannot tell you whether your
 * own team caused it, how much credit you accepted without looking at it, or which
 * credit is about to expire while everyone watches this month's numbers.
 */
export function Findings({ result }: { result: AnalysisResult }) {
  const split = result.attributionSplit.filter((entry) => entry.count > 0);
  const supplierCaused = split.filter((entry) => entry.attribution.startsWith('supplier_'));
  const recipientCaused = split.filter((entry) => entry.isRecipientCause);
  const totalValue = split.reduce((sum, entry) => sum + entry.taxValue, 0);

  return (
    <div className="px-6 py-6">
      <h1 className="text-ink text-[22px] font-semibold tracking-tight">Findings</h1>
      <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
        Three things a reconciliation report cannot tell you.
      </p>

      {/* ---------------------------------------------------- attribution */}
      <section className="border-rule mt-6 border-t pt-5">
        <SectionHeading note={{ label: 'attribution', text: EXPLANATIONS.attribution }}>
          1. Whose fault is the missing credit?
        </SectionHeading>

        {!result.deemedAcceptance.imsLogSupplied ? (
          <div className="mt-3 max-w-2xl">
            <Notice title="No IMS action log was supplied, so nothing can be attributed">
              Without it, a missing invoice might be your supplier&rsquo;s failure to file, or
              it might be a record your own team rejected. This tool will not guess between
              the two. Upload an IMS action log per period to see this split.
            </Notice>
          </div>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full max-w-3xl border-collapse text-[13px]">
                <thead>
                  <tr className="border-rule text-ink-muted border-b text-[11px]">
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Cause
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Whose
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Documents
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Tax
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {split.map((entry) => (
                    <tr key={entry.attribution} className="border-rule border-b">
                      <td className="px-3 py-1.5">{attributionLabel(entry.attribution)}</td>
                      <td className="px-3 py-1.5">
                        {entry.isRecipientCause ? (
                          <span className="text-flag-amber">Yours</span>
                        ) : entry.attribution.startsWith('supplier_') ? (
                          <span className="text-ink-muted">Supplier</span>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                      <td className="num px-3 py-1.5">{formatCount(entry.count)}</td>
                      <td className="num px-3 py-1.5">
                        <Money value={entry.taxValue} />
                      </td>
                      <td className="num px-3 py-1.5">
                        {formatPercent(totalValue === 0 ? 0 : entry.taxValue / totalValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {recipientCaused.length > 0 && (
              <div className="mt-4 max-w-2xl">
                <Notice tone="warning" title="Some of this is your own doing, not your suppliers’">
                  <Money
                    value={recipientCaused.reduce((sum, entry) => sum + entry.taxValue, 0)}
                  />{' '}
                  of credit is missing because your team rejected or held the record in IMS,
                  against{' '}
                  <Money value={supplierCaused.reduce((sum, entry) => sum + entry.taxValue, 0)} />{' '}
                  caused by suppliers. Chasing a supplier for the first kind wastes the call and
                  damages the relationship. These are an internal control finding.
                </Notice>
              </div>
            )}
          </>
        )}
      </section>

      {/* ----------------------------------------------- deemed acceptance */}
      <section className="border-rule mt-8 border-t pt-5">
        <SectionHeading note={{ label: 'deemed acceptance', text: EXPLANATIONS.deemedAccepted }}>
          2. How much did you accept without looking at it?
        </SectionHeading>

        {!result.deemedAcceptance.imsLogSupplied ? (
          <p className="text-ink-muted mt-2 max-w-2xl text-[13px]">
            No IMS action log was supplied, so this cannot be measured.
          </p>
        ) : (
          <div className="mt-3 max-w-3xl">
            <div className="border-rule bg-field flex flex-wrap items-baseline gap-8 border px-5 py-4">
              <div>
                <div className="num text-ink text-[32px] leading-none">
                  {formatPercent(result.deemedAcceptance.share)}
                </div>
                <div className="text-ink-muted mt-1 text-[11px]">of records deemed accepted</div>
              </div>
              <div>
                <div className="num text-ink text-[22px] leading-none">
                  {formatCount(result.deemedAcceptance.count)}
                </div>
                <div className="text-ink-muted mt-1 text-[11px]">records</div>
              </div>
              <div>
                <div className="num text-ink text-[22px] leading-none">
                  <Money value={result.deemedAcceptance.taxValue} compact />
                </div>
                <div className="text-ink-muted mt-1 text-[11px]">tax accepted by default</div>
              </div>
            </div>

            <p className="text-ink mt-4 text-[14px] leading-relaxed">
              These records reached your GSTR-2B and nobody acted on them, so they were
              accepted automatically when GSTR-3B was filed. That is not a supplier problem
              and it does not cost you credit today. It is a control weakness: whatever a
              supplier reported against your GSTIN — including a document you would have
              rejected on sight — went into your return unexamined. The remedy is a review
              step before filing, not a phone call.
            </p>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------- credit notes */}
      {result.creditNotes.rejected.count > 0 && (
        <section className="border-rule mt-8 border-t pt-5">
          <SectionHeading note={{ label: 'rejected credit notes', text: EXPLANATIONS.rejectedCreditNote }}>
            Credit notes you rejected
          </SectionHeading>
          <p className="text-ink mt-2 max-w-3xl text-[14px]">
            Rejecting a credit note pushes the liability back to the supplier: it increases
            what they owe in their next GSTR-3B. Worth being certain about each of these.
          </p>
          <table className="mt-3 w-full max-w-3xl border-collapse text-[13px]">
            <thead>
              <tr className="border-rule text-ink-muted border-b text-[11px]">
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Supplier
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Note
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Tax
                </th>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Reason given
                </th>
              </tr>
            </thead>
            <tbody>
              {result.creditNotes.rejected.rows.map((row) => (
                <tr key={`${row.supplierGstin ?? ''}${row.invoiceNumber}`} className="border-rule border-b">
                  <td className="px-3 py-1.5">{row.supplierName}</td>
                  <td className="num px-3 py-1.5 text-left">{row.invoiceNumber}</td>
                  <td className="num px-3 py-1.5">
                    <Money value={row.taxValue} />
                  </td>
                  <td className="text-ink-muted px-3 py-1.5">{row.remark ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* --------------------------------------------------- pending ageing */}
      <section className="border-rule mt-8 border-t pt-5">
        <SectionHeading note={{ label: 'the 30 November deadline', text: EXPLANATIONS.section16_4 }}>
          3. Credit that is quietly about to expire
        </SectionHeading>

        {result.pendingAgeing.rows.length === 0 ? (
          <p className="text-ink-muted mt-2 max-w-2xl text-[13px]">
            Nothing is pending in IMS. Nothing is ageing towards its section 16(4) deadline.
          </p>
        ) : (
          <>
            <div className="border-rule mt-4 flex max-w-2xl border">
              {(['0-30', '31-60', '61-90', '90+'] as const).map((bucket, index) => {
                const totals = result.pendingAgeing.byBucket[bucket];
                return (
                  <div
                    key={bucket}
                    className={`flex-1 px-4 py-3 ${index > 0 ? 'border-rule border-l' : ''}`}
                  >
                    <div className="num text-ink text-[20px] leading-none">
                      {formatCount(totals.rows)}
                    </div>
                    <div className="text-ink-muted mt-1 text-[11px]">{bucket} days</div>
                    <div className="num text-ink-muted mt-1 text-left text-[11px]">
                      <Money value={totals.taxValue} />
                    </div>
                  </div>
                );
              })}
            </div>

            {result.pendingAgeing.atRiskOfExpiryTaxValue > 0 && (
              <div className="mt-4 max-w-2xl">
                <Notice tone="error" title="Credit here will expire if nobody acts">
                  <Money value={result.pendingAgeing.atRiskOfExpiryTaxValue} /> of input tax
                  credit sits on records that are pending and close to their 30 November
                  cut-off. After that date the credit is not late — it is gone, and no
                  correction brings it back.
                </Notice>
              </div>
            )}

            <div className="mt-4 overflow-x-auto">
              <table className="w-full max-w-4xl border-collapse text-[13px]">
                <thead>
                  <tr className="border-rule text-ink-muted border-b text-[11px]">
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Supplier
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Invoice
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Date
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Tax
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Pending
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Claim by
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Time left
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.pendingAgeing.rows.map((row) => (
                    <tr key={row.imsRowId} className="border-rule border-b">
                      <td className="px-3 py-1.5">{row.supplierName || '—'}</td>
                      <td className="num px-3 py-1.5 text-left">{row.invoiceNumber}</td>
                      <td className="num px-3 py-1.5 text-left">{formatDate(row.invoiceDate)}</td>
                      <td className="num px-3 py-1.5">
                        <Money value={row.taxValue} />
                      </td>
                      <td className="num px-3 py-1.5">{row.ageDays} d</td>
                      <td className="num px-3 py-1.5 text-left">
                        {formatDate(row.section16_4Deadline)}
                      </td>
                      <td className="num px-3 py-1.5">{formatDays(row.daysToDeadline)}</td>
                      <td className="px-3 py-1.5">
                        <DeadlineChip flag={row.deadlineFlag} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-ink-muted mt-2 text-[12px]">
              Ageing measured as at {result.pendingAgeing.asOf}. {EXPLANATIONS.pendingAgeing}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
