import { useState } from 'react';
import type { AnalysisResult, FileKind, FileMapping, InputFile } from '../../engine/types';
import { Notice, SectionHeading } from '../components/primitives';
import { formatCount } from '../format';

/**
 * File slots and the column mapping table.
 *
 * Real Tally exports have wildly inconsistent headers, so the engine guesses and this
 * screen shows the guess with a live preview of the first rows. Anything the engine was
 * not sure about is marked, and the user gets the last word — they know what the column
 * means and the fuzzy matcher does not.
 */

const SLOTS: Array<{ kind: FileKind; label: string; hint: string; required: boolean; periodic: boolean }> = [
  {
    kind: 'purchaseRegister',
    label: 'Purchase register',
    hint: 'One file per period, from Tally or your accounting system. CSV or Excel.',
    required: true,
    periodic: true,
  },
  {
    kind: 'gstr2b',
    label: 'GSTR-2B',
    hint: 'The Excel download from the GST portal, one per period. JSON is not supported yet.',
    required: true,
    periodic: true,
  },
  {
    kind: 'imsLog',
    label: 'IMS action log',
    hint: 'Optional. Without it, no gap can be attributed to anyone.',
    required: false,
    periodic: true,
  },
  {
    kind: 'supplierMaster',
    label: 'Supplier master',
    hint: 'Optional. Adds contact details and declared filing frequency.',
    required: false,
    periodic: false,
  },
];

export interface PendingFile {
  kind: FileKind;
  fileName: string;
  period: string | null;
  content: ArrayBuffer | string;
}

/** Period inferred from a file name like `purchase-register-2026-04.csv`. */
export function periodFromFileName(fileName: string): string | null {
  return /(\d{4})[-_](\d{2})/.exec(fileName)?.slice(1, 3).join('-') ?? null;
}

export function Files({
  files,
  onAddFiles,
  onRemoveFile,
  onSetPeriod,
  onAnalyse,
  onUpdateMapping,
  result,
  busy,
}: {
  files: readonly PendingFile[];
  onAddFiles: (kind: FileKind, list: FileList) => void;
  onRemoveFile: (fileName: string) => void;
  onSetPeriod: (fileName: string, period: string) => void;
  onAnalyse: () => void;
  onUpdateMapping: (mapping: FileMapping) => void;
  result: AnalysisResult | null;
  busy: boolean;
}) {
  const registers = files.filter((file) => file.kind === 'purchaseRegister').length;
  const twoBs = files.filter((file) => file.kind === 'gstr2b').length;
  const ready = registers > 0 && twoBs > 0;

  return (
    <div className="px-6 py-6">
      <h1 className="text-ink text-[22px] font-semibold tracking-tight">Files and mapping</h1>
      <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
        Add a purchase register and a GSTR-2B for each period. Three periods is the minimum
        that produces a score; six to twelve is where this tool earns its keep.
      </p>

      <div className="border-rule mt-6 border-t">
        {SLOTS.map((slot) => {
          const forSlot = files.filter((file) => file.kind === slot.kind);

          return (
            <section key={slot.kind} className="border-rule border-b py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-4">
                <div>
                  <h2 className="text-ink text-[14px] font-semibold">
                    {slot.label}
                    {slot.required ? '' : ' (optional)'}
                  </h2>
                  <p className="text-ink-muted mt-1 max-w-xl text-[13px]">{slot.hint}</p>
                </div>
                <label className="border-rule text-ink hover:bg-field cursor-pointer border px-3 py-1.5 text-[13px]">
                  Add files
                  <input
                    type="file"
                    multiple={slot.periodic}
                    accept=".csv,.xlsx,.xls,.json,text/csv"
                    className="sr-only"
                    onChange={(event) => {
                      if (event.target.files) onAddFiles(slot.kind, event.target.files);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>

              {forSlot.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {forSlot.map((file) => (
                    <li
                      key={file.fileName}
                      className="border-rule flex flex-wrap items-center gap-3 border-b py-1.5 text-[13px] last:border-b-0"
                    >
                      <span className="num text-ink flex-1 text-left">{file.fileName}</span>
                      {slot.periodic && (
                        <label className="text-ink-muted flex items-center gap-2 text-[12px]">
                          Period
                          <input
                            type="text"
                            value={file.period ?? ''}
                            placeholder="YYYY-MM"
                            onChange={(event) => {
                              onSetPeriod(file.fileName, event.target.value);
                            }}
                            className={`num border-rule w-24 border px-2 py-0.5 text-left text-[12px] ${
                              file.period ? '' : 'border-flag-amber'
                            }`}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveFile(file.fileName);
                        }}
                        className="text-ink-muted hover:text-flag-red text-[12px]"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {!ready && (
        <div className="mt-6 max-w-2xl">
          <Notice title="A purchase register and a GSTR-2B are both needed">
            Add at least one of each. Everything else is optional, and the interface says
            plainly what it cannot tell you without them.
          </Notice>
        </div>
      )}

      <button
        type="button"
        onClick={onAnalyse}
        disabled={!ready || busy}
        className="bg-accent mt-6 px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-40"
      >
        {busy ? 'Analysing' : 'Analyse'}
      </button>

      {result && result.mappings.length > 0 && (
        <MappingTables mappings={result.mappings} onUpdateMapping={onUpdateMapping} />
      )}
    </div>
  );
}

function MappingTables({
  mappings,
  onUpdateMapping,
}: {
  mappings: readonly FileMapping[];
  onUpdateMapping: (mapping: FileMapping) => void;
}) {
  const [openFile, setOpenFile] = useState<string | null>(mappings[0]?.fileName ?? null);
  const mapping = mappings.find((entry) => entry.fileName === openFile) ?? mappings[0];

  if (!mapping) return null;

  const unmappedRequired = mapping.fields.filter(
    (field) => field.required && field.sourceHeader === null,
  );

  return (
    <section className="border-rule mt-8 border-t pt-5">
      <SectionHeading>Column mapping</SectionHeading>
      <p className="text-ink-muted mt-1 max-w-2xl text-[13px]">
        What the engine made of each file&rsquo;s headers. Correct anything it guessed
        wrongly — a fuzzy match is a guess, and it says so.
      </p>

      <div className="mt-3 flex flex-wrap gap-1">
        {mappings.map((entry) => (
          <button
            key={entry.fileName}
            type="button"
            aria-pressed={entry.fileName === mapping.fileName}
            onClick={() => {
              setOpenFile(entry.fileName);
            }}
            className={`num border px-2 py-1 text-[12px] ${
              entry.fileName === mapping.fileName
                ? 'border-accent text-accent font-semibold'
                : 'border-rule text-ink-muted hover:bg-field'
            }`}
          >
            {entry.fileName}
          </button>
        ))}
      </div>

      {unmappedRequired.length > 0 && (
        <div className="mt-4 max-w-2xl">
          <Notice tone="warning" title="Some required columns were not found">
            {unmappedRequired.map((field) => field.label).join(', ')}. Choose the right column
            below, or the analysis will be missing that information.
          </Notice>
        </div>
      )}

      <p className="text-ink-muted mt-4 text-[12px]">
        Header found on row{' '}
        <span className="num text-ink">{mapping.headerRowIndex + 1}</span> of{' '}
        <span className="num text-ink">{mapping.fileName}</span>.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full max-w-4xl border-collapse text-[13px]">
          <thead>
            <tr className="border-rule text-ink-muted border-b text-[11px]">
              <th scope="col" className="px-3 py-2 text-left font-normal">
                Field
              </th>
              <th scope="col" className="px-3 py-2 text-left font-normal">
                Column in your file
              </th>
              <th scope="col" className="px-3 py-2 text-left font-normal">
                Confidence
              </th>
              <th scope="col" className="px-3 py-2 text-left font-normal">
                What it is for
              </th>
            </tr>
          </thead>
          <tbody>
            {mapping.fields.map((field) => (
              <tr key={field.field} className="border-rule border-b">
                <td className="px-3 py-1.5">
                  {field.label}
                  {field.required && <span className="text-flag-red ml-1">*</span>}
                </td>
                <td className="px-3 py-1.5">
                  <select
                    value={field.sourceHeader ?? ''}
                    onChange={(event) => {
                      onUpdateMapping({
                        ...mapping,
                        fields: mapping.fields.map((entry) =>
                          entry.field === field.field
                            ? {
                                ...entry,
                                sourceHeader: event.target.value === '' ? null : event.target.value,
                                confidence: event.target.value === '' ? 'none' : 'exact',
                              }
                            : entry,
                        ),
                      });
                    }}
                    className="border-rule w-full border px-2 py-1 text-[12px]"
                  >
                    <option value="">Not mapped</option>
                    {mapping.availableHeaders
                      .filter((header) => header !== '')
                      .map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="px-3 py-1.5">
                  {field.confidence === 'exact' && <span className="text-flag-green">● Exact</span>}
                  {field.confidence === 'fuzzy' && (
                    <span className="text-flag-amber">▲ Best guess</span>
                  )}
                  {field.confidence === 'none' && (
                    <span className="text-ink-muted">– Not found</span>
                  )}
                </td>
                <td className="text-ink-muted px-3 py-1.5">{field.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {mapping.preview.length > 0 && (
        <div className="mt-5">
          <h3 className="text-ink text-[13px] font-semibold">
            First {formatCount(mapping.preview.length)} rows as read
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="border-collapse text-[12px]">
              <thead>
                <tr className="border-rule text-ink-muted border-b text-[11px]">
                  {mapping.availableHeaders
                    .filter((header) => header !== '')
                    .map((header) => (
                      <th key={header} scope="col" className="px-2 py-1 text-left font-normal">
                        {header}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {mapping.preview.map((row, index) => (
                  <tr key={index} className="border-rule border-b">
                    {mapping.availableHeaders
                      .filter((header) => header !== '')
                      .map((header) => (
                        <td key={header} className="num px-2 py-1 text-left whitespace-nowrap">
                          {row[header] ?? ''}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** Turns the browser's File objects into engine inputs, reading bytes for spreadsheets. */
export async function readPendingFiles(
  kind: FileKind,
  list: FileList,
): Promise<PendingFile[]> {
  const out: PendingFile[] = [];

  for (const file of Array.from(list)) {
    const isText = /\.(csv|txt)$/i.test(file.name);
    const content = isText ? await file.text() : await file.arrayBuffer();
    out.push({
      kind,
      fileName: file.name,
      period: kind === 'supplierMaster' ? null : periodFromFileName(file.name),
      content,
    });
  }

  return out;
}

export function toInputFiles(
  files: readonly PendingFile[],
  mappings: ReadonlyMap<string, FileMapping>,
): InputFile[] {
  return files.map((file) => {
    const mapping = mappings.get(file.fileName);
    return {
      kind: file.kind,
      fileName: file.fileName,
      period: file.period,
      content: file.content,
      ...(mapping ? { mapping } : {}),
    };
  });
}
