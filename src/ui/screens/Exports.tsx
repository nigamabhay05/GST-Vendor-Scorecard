import { useState } from 'react';
import {
  dataHealthCsv,
  followUpEmailsText,
  invoiceDetailCsv,
  scorecardCsv,
} from '../../engine/export/csv';
import { projectFileName, serialiseProjectFile } from '../../engine/export/projectFile';
import type { AnalysisResult, ProjectFile } from '../../engine/types';
import { Notice, SectionHeading } from '../components/primitives';
import { formatCount } from '../format';

/**
 * Exports.
 *
 * Every download is built in the browser from the result already on screen and handed
 * straight to the user. Nothing is posted anywhere; the object URL is revoked as soon as
 * the click has been dispatched.
 */

function download(fileName: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

export function Exports({
  result,
  buildProject,
}: {
  result: AnalysisResult;
  buildProject: () => ProjectFile | null;
}) {
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const stamp = result.meta.asOf;
  const note = (name: string) => {
    setLastSaved(name);
  };

  const items = [
    {
      key: 'scorecard',
      title: 'Scorecard',
      detail: `${formatCount(result.suppliers.length)} suppliers, one row each, with every score component and the suggested action.`,
      button: 'Download scorecard',
      run: () => {
        const name = `gst-scorecard-${stamp}.csv`;
        download(name, scorecardCsv(result), 'text/csv');
        note(name);
      },
    },
    {
      key: 'detail',
      title: 'Invoice detail',
      detail: `${formatCount(result.matches.length)} documents with match status, tier and attribution.`,
      button: 'Download invoice detail',
      run: () => {
        const name = `gst-invoice-detail-${stamp}.csv`;
        download(name, invoiceDetailCsv(result), 'text/csv');
        note(name);
      },
    },
    {
      key: 'health',
      title: 'Data health findings',
      detail:
        'Every GSTIN warning, unreadable date, dropped row and exclusion, with the file and row it came from.',
      button: 'Download data health',
      run: () => {
        const name = `gst-data-health-${stamp}.csv`;
        download(name, dataHealthCsv(result), 'text/csv');
        note(name);
      },
    },
    {
      key: 'emails',
      title: 'Follow-up emails',
      detail:
        result.followUpEmails.length === 0
          ? 'No emails were generated: no supplier has credit at risk attributable to them.'
          : `${formatCount(result.followUpEmails.length)} emails, ready to paste into your mail client.`,
      button: 'Download emails',
      run: () => {
        const name = `gst-follow-up-emails-${stamp}.txt`;
        download(name, followUpEmailsText(result.followUpEmails), 'text/plain');
        note(name);
      },
    },
  ];

  return (
    <div className="px-6 py-6">
      <h1 className="text-ink text-[22px] font-semibold tracking-tight">Exports</h1>
      <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
        Everything is built here in your browser and saved to your machine.
      </p>

      <div className="border-rule mt-6 border-t">
        {items.map((item) => (
          <div
            key={item.key}
            className="border-rule flex flex-wrap items-baseline justify-between gap-4 border-b py-4"
          >
            <div className="max-w-xl">
              <p className="text-ink text-[14px] font-semibold">{item.title}</p>
              <p className="text-ink-muted mt-1 text-[13px]">{item.detail}</p>
            </div>
            <button
              type="button"
              onClick={item.run}
              className="border-rule text-ink hover:bg-field border px-3 py-1.5 text-[13px]"
            >
              {item.button}
            </button>
          </div>
        ))}
      </div>

      <section className="mt-8">
        <SectionHeading>Save project</SectionHeading>
        <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
          This is the only way this tool remembers anything. A project file holds the parsed
          rows, your column mappings and your date answers, so you can reopen the analysis
          without the original spreadsheets. It contains client tax data, so it is saved to
          your machine and nowhere else — nothing is kept in the browser.
        </p>
        <button
          type="button"
          onClick={() => {
            const project = buildProject();
            if (!project) return;
            const name = projectFileName(result.meta.asOf, result.meta.buyerGstin);
            download(name, serialiseProjectFile(project), 'application/json');
            note(name);
          }}
          className="bg-accent mt-3 px-4 py-2 text-[14px] font-semibold text-white"
        >
          Save project
        </button>
      </section>

      {lastSaved && (
        <div className="mt-6 max-w-2xl">
          <Notice title="Saved">
            <span className="num">{lastSaved}</span> was written to your downloads folder.
          </Notice>
        </div>
      )}
    </div>
  );
}
