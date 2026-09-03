import { PrivacyLine } from '../components/primitives';

/**
 * The Start screen.
 *
 * The primary path is one click to a full dashboard. A first-time visitor should not
 * meet an empty upload form -- they should see the tool working on realistic data, and
 * only then decide whether to spend twenty minutes exporting their own.
 */
export function Start({
  onLoadSample,
  onUpload,
  onLoadProject,
  busy,
}: {
  onLoadSample: () => void;
  onUpload: () => void;
  onLoadProject: (file: File) => void;
  busy: boolean;
}) {
  return (
    <div className="mx-auto max-w-2xl px-8 py-16">
      <h1 className="text-ink text-[32px] leading-tight font-semibold tracking-tight">
        Which suppliers will cost you input tax credit next month?
      </h1>

      <p className="text-ink mt-5 text-[15px] leading-relaxed">
        You only get input tax credit if your supplier reports the invoice in their GSTR-1,
        so it reaches your GSTR-2B. Now that GSTR-3B is locked to GSTR-2B, one supplier who
        files late blocks your credit and costs you cash. Reconciliation tells you this
        after it has happened. This reads several months of your own history and tells you
        which suppliers are about to do it again, how much it will cost, and what to do now.
      </p>

      <div className="border-rule mt-10 border-t">
        <div className="border-rule flex items-baseline justify-between gap-6 border-b py-5">
          <div>
            <button
              type="button"
              onClick={onLoadSample}
              disabled={busy}
              className="bg-accent px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Loading sample data' : 'Load sample data'}
            </button>
            <p className="text-ink-muted mt-2 max-w-md text-[13px]">
              Generated demonstration data: 25 suppliers, 8 periods, 382 documents. Not real
              client data. Opens the full scorecard immediately.
            </p>
          </div>
        </div>

        <div className="border-rule flex items-baseline justify-between gap-6 border-b py-5">
          <div>
            <button
              type="button"
              onClick={onUpload}
              disabled={busy}
              className="border-rule text-ink hover:bg-field border px-4 py-2 text-[14px] disabled:opacity-50"
            >
              Upload your own files
            </button>
            <p className="text-ink-muted mt-2 max-w-md text-[13px]">
              A purchase register and a GSTR-2B for each period. Optionally a supplier master
              and an IMS action log. Three periods minimum; six to twelve works best.
            </p>
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-6 py-5">
          <div>
            <label className="border-rule text-ink hover:bg-field inline-block cursor-pointer border px-4 py-2 text-[14px]">
              Load a saved project
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onLoadProject(file);
                  event.target.value = '';
                }}
              />
            </label>
            <p className="text-ink-muted mt-2 max-w-md text-[13px]">
              A project file you saved earlier from this tool.
            </p>
          </div>
        </div>
      </div>

      <div className="border-rule mt-10 border-t pt-5">
        <PrivacyLine />
        <p className="text-ink-muted mt-2 text-[12px]">
          There is no server, no account and no database. This page makes no network
          requests after it loads, which you can confirm in your browser&rsquo;s network
          panel. Saving a project downloads a file to your machine; nothing is stored in the
          browser.
        </p>
      </div>
    </div>
  );
}
