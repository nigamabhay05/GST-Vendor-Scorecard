import { formatPeriod } from '../normalize/period';
import type { DateOnly, FollowUpEmail, SupplierScorecardEntry } from '../types';

/**
 * Generated follow-up emails.
 *
 * The point of these is that they are specific. "Please file your returns" achieves
 * nothing; a message naming the invoices, their value, and the date by which they must
 * appear gives the supplier's accounts clerk something they can act on without a phone
 * call. Written plainly and without threats -- the recipient is a colleague at another
 * business who is usually just behind on their filing.
 *
 * Emails are only generated for suppliers with something to chase, and only the buyer
 * ever sends them: nothing here transmits anything anywhere.
 */

/** Formats rupees with Indian lakh/crore grouping. */
function formatInr(value: number): string {
  const rounded = Math.round(value);
  const text = String(Math.abs(rounded));
  const last3 = text.slice(-3);
  const rest = text.slice(0, -3);
  const grouped =
    rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${rounded < 0 ? '-' : ''}₹${grouped}`;
}

export function shouldChase(supplier: SupplierScorecardEntry): boolean {
  if (supplier.itcAtRisk <= 0) return false;

  // Never chase a supplier for credit the buyer's own team rejected or is holding.
  const recipientCaused =
    supplier.attributionValue.recipient_rejected +
    supplier.attributionValue.recipient_kept_pending;
  const supplierCaused =
    supplier.attributionValue.supplier_never_reported +
    supplier.attributionValue.supplier_reported_late;

  return supplierCaused > recipientCaused;
}

export function buildFollowUpEmail(
  supplier: SupplierScorecardEntry,
  asOf: DateOnly,
): FollowUpEmail {
  const greeting = supplier.contact?.contactPerson
    ? `Dear ${supplier.contact.contactPerson},`
    : 'Dear Sir or Madam,';

  const periodsCovered = supplier.monthlyMatchRate
    .filter((entry) => entry.inScopeValue > 0)
    .map((entry) => formatPeriod(entry.period));

  const rangeText =
    periodsCovered.length === 0
      ? 'recent periods'
      : periodsCovered.length === 1
        ? periodsCovered[0]
        : `${periodsCovered[0] ?? ''} to ${periodsCovered[periodsCovered.length - 1] ?? ''}`;

  const lines: string[] = [
    greeting,
    '',
    `We have reviewed our purchase records against GSTR-2B for ${rangeText}.`,
    '',
  ];

  /*
   * Two different letters, because two different things went wrong.
   *
   * Asking a supplier to file returns you a filing acknowledgement and no credit, when
   * the problem was that they filed against somebody else's GSTIN. Their other invoices
   * arriving on time in the same periods is what tells us which letter to send.
   */
  if (supplier.wrongRecipientGstinSuspected) {
    lines.push(
      `Input tax credit of ${formatInr(supplier.itcAtRisk)} against invoices we hold from you ` +
        'has not appeared in our GSTR-2B for any period.',
      '',
      'Your other invoices for the same periods have reached us on time, so we do not think ' +
        'this is a filing delay. The likeliest explanation is that these particular invoices ' +
        'were reported against a different recipient GSTIN.',
      '',
      'Could you please check the recipient GSTIN recorded against these documents in your ' +
        'billing system, against the GSTIN on our purchase orders. If it is incorrect, the ' +
        'correction can be made through GSTR-1A so the credit reaches us in the next cycle.',
    );
  } else {
    lines.push(
      `Input tax credit of ${formatInr(supplier.itcAtRisk)} against invoices we hold from you ` +
        'has not yet appeared in our GSTR-2B. Since our GSTR-3B is locked to GSTR-2B, we are ' +
        'unable to claim this credit until the invoices are reported in your GSTR-1.',
    );
  }

  if (supplier.components.avgDelayMonths >= 1) {
    lines.push(
      '',
      `On average your invoices have reached our GSTR-2B about ${supplier.components.avgDelayMonths.toFixed(1)} ` +
        'months after the invoice date. Filing within the period would let us claim the credit ' +
        'in the same month we book the purchase.',
    );
  }

  lines.push(
    '',
    ...(supplier.wrongRecipientGstinSuspected
      ? [
          'Could you confirm:',
          '  1. The recipient GSTIN recorded against these invoices in your system.',
          '  2. If it is wrong, when the GSTR-1A correction will be filed.',
        ]
      : [
          'Could you confirm:',
          '  1. Whether these invoices were included in your GSTR-1, and for which period.',
          '  2. If they were missed, the period in which you will report them.',
        ]),
    '',
    'A copy of the invoice list is attached to this message.',
    '',
    'We would be grateful for a reply before the 11th of this month, so that any correction ' +
      'reaches our next GSTR-2B.',
    '',
    'Thank you,',
    '',
    `(Sent from our vendor GST review, ${asOf})`,
  );

  return {
    supplierKey: supplier.key,
    supplierName: supplier.name,
    to: supplier.contact?.email ?? null,
    subject: `GST input credit not yet reflected - ${supplier.name} - ${formatInr(supplier.itcAtRisk)}`,
    body: lines.join('\n'),
  };
}

export function buildFollowUpEmails(
  suppliers: readonly SupplierScorecardEntry[],
  asOf: DateOnly,
): FollowUpEmail[] {
  return suppliers.filter(shouldChase).map((supplier) => buildFollowUpEmail(supplier, asOf));
}
