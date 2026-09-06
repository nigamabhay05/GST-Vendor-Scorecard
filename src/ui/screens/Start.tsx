import { PrivacyLine } from '../components/primitives';

/**
 * The Start screen.
 *
 * The primary path is one click to a full dashboard. A first-time visitor should not
 * meet an empty upload form -- they should see the tool working on realistic data, and
 * only then decide whether to spend twenty minutes exporting their own.
 *
 * Both actions are kept above the fold. The three reasons reconciliation falls short run
 * across the page rather than down it, so the argument is made without pushing the two
 * buttons off the bottom of the screen -- a visitor who has to scroll to find the thing
 * they came to click has already been asked for more than the page deserves.
 */

const RECONCILIATION_GAPS = [
  {
    claim: 'It’s backward-looking.',
    detail:
      'Reconciliation tells you what already broke, days before your filing deadline — by then there’s little you can do.',
  },
  {
    claim: 'It treats every gap the same.',
    detail:
      'A missing invoice could mean the supplier never filed, or that your own team rejected it in IMS by mistake. Reconciliation can’t tell you which.',
  },
  {
    claim: 'It resets every month.',
    detail:
      'It has no memory of which suppliers are chronically late, so you’re always reacting, never anticipating.',
  },
] as const;

/**
 * The four accepted inputs, laid out two by two.
 *
 * The optional pair is marked rather than hidden: a user needs to know up front that the
 * IMS log is what makes attribution possible, so they can decide whether to go and fetch
 * it before starting rather than discovering the gap at the Findings screen.
 */
const INPUTS = [
  {
    name: 'Purchase register',
    required: true,
    detail: 'One file per period, from Tally or similar. CSV or Excel.',
  },
  {
    name: 'GSTR-2B',
    required: true,
    detail: 'The Excel download from the GST portal, one per period.',
  },
  {
    name: 'Supplier master',
    required: false,
    detail: 'Contact details and filing frequency. Enables follow-up emails.',
  },
  {
    name: 'IMS action log',
    required: false,
    detail: 'Without it, no gap can be attributed to supplier or to you.',
  },
] as const;

/** Tray with an arrow going into it. Decorative: the button already says "Upload". */
function UploadIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      className="shrink-0"
    >
      <path d="M8 10.5V2" />
      <path d="M4.5 5.5 8 2l3.5 3.5" />
      <path d="M2.5 10v3.5h11V10" />
    </svg>
  );
}

export function Start({
  onLoadSample,
  onUpload,
  busy,
}: {
  onLoadSample: () => void;
  onUpload: () => void;
  busy: boolean;
}) {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-ink text-[30px] leading-tight font-semibold tracking-tight">
        Reduce the chances of ITC Blockage with ITC Risk Radar &mdash; Keep your Working
        Capital safe
      </h1>

      <p className="text-ink mt-4 max-w-2xl text-[15px] leading-relaxed">
        You only get input tax credit if your supplier reports the invoice in their GSTR-1
        so it reaches your GSTR-2B. GSTR-3B is now locked to GSTR-2B, so one late-filing
        supplier blocks your credit and costs you cash.
      </p>

      <section className="mt-7">
        <h2 className="text-ink text-[15px] font-semibold">
          Why reconciliation isn&rsquo;t enough
        </h2>

        <dl className="border-rule mt-3 grid grid-cols-1 gap-x-6 border-t pt-3 sm:grid-cols-3">
          {RECONCILIATION_GAPS.map((gap, index) => (
            <div
              key={gap.claim}
              className={
                index > 0
                  ? 'border-rule mt-3 border-t pt-3 sm:mt-0 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-6'
                  : ''
              }
            >
              <dt className="text-ink text-[13px] leading-snug font-semibold">{gap.claim}</dt>
              <dd className="text-ink-muted mt-1 text-[13px] leading-snug">{gap.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="mt-7">
        <button
          type="button"
          onClick={onLoadSample}
          disabled={busy}
          className="bg-accent hover:bg-accent-strong focus-visible:outline-accent inline-block px-6 py-4 text-left text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          <span className="block text-[18px] leading-tight font-semibold">
            {busy ? 'Loading dummy data' : 'Try ITC Risk Radar with dummy data'}
          </span>
          <span className="mt-1 block text-[13px] leading-snug text-white/80">
            Know exactly how this works
          </span>
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={onUpload}
          disabled={busy}
          className="border-rule text-ink hover:bg-field inline-flex items-center gap-2 border px-4 py-2 text-[14px] disabled:opacity-50"
        >
          Upload your own files
          <UploadIcon />
        </button>
        <p className="text-ink-muted text-[13px]">
          Four inputs accepted, two required. Three periods minimum; six to twelve works best.
        </p>
      </div>

      <ul className="border-rule mt-4 grid grid-cols-1 border-t border-l sm:grid-cols-2">
        {INPUTS.map((input) => (
          <li key={input.name} className="border-rule border-r border-b px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ink text-[14px] font-semibold">{input.name}</span>
              <span
                className={
                  input.required
                    ? 'text-flag-red text-[11px] whitespace-nowrap'
                    : 'text-ink-muted text-[11px] whitespace-nowrap'
                }
              >
                {input.required ? 'Required' : 'Optional'}
              </span>
            </div>
            <p className="text-ink-muted mt-1 text-[12px] leading-snug">{input.detail}</p>
          </li>
        ))}
      </ul>

      <p className="text-ink-muted mt-4 text-[12px]">
        Sample data is generated demonstration data: 25 suppliers, 8 periods, 382 documents.
        Not real client data.
      </p>

      <div className="border-rule mt-8 border-t pt-5">
        <PrivacyLine />
        <p className="text-ink-muted mt-2 text-[12px]">
          There is no server, no account and no database. This page makes no network
          requests after it loads, which you can confirm in your browser&rsquo;s network
          panel.
        </p>
      </div>
    </div>
  );
}
