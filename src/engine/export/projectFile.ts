import type {
  BookRow,
  FileMapping,
  Gstin,
  ImsLogRow,
  Portal2bRow,
  ProjectFile,
  SlashDateFormatAnswers,
  SupplierMasterRow,
} from '../types';

/**
 * The project file: this application's only form of persistence.
 *
 * Nothing is written to localStorage, sessionStorage or IndexedDB at any point -- the
 * lint rules in eslint.config.js make that a build failure rather than a promise. The
 * user presses "Save project", a JSON file lands in their downloads folder, and it is
 * theirs. It contains client tax data, so it belongs on their machine and nowhere else.
 */

export const PROJECT_FILE_VERSION = 1;

export interface BuildProjectFileInput {
  buyerGstin: Gstin | null;
  asOf: string;
  isSampleData: boolean;
  mappings: readonly FileMapping[];
  dateFormatAnswers: SlashDateFormatAnswers;
  extraBlockedSuppliers: readonly string[];
  bookRows: readonly BookRow[];
  portalRows: readonly Portal2bRow[];
  supplierMaster: readonly SupplierMasterRow[];
  imsRows: readonly ImsLogRow[];
  /** Explicit so a saved project records when it was saved, not when it is opened. */
  savedAt: string;
}

export function buildProjectFile(input: BuildProjectFileInput): ProjectFile {
  return {
    formatVersion: PROJECT_FILE_VERSION,
    savedAt: input.savedAt,
    buyerGstin: input.buyerGstin,
    asOf: input.asOf,
    isSampleData: input.isSampleData,
    mappings: [...input.mappings],
    dateFormatAnswers: { ...input.dateFormatAnswers },
    extraBlockedSuppliers: [...input.extraBlockedSuppliers],
    data: {
      bookRows: [...input.bookRows],
      portalRows: [...input.portalRows],
      supplierMaster: [...input.supplierMaster],
      imsRows: [...input.imsRows],
    },
  };
}

export function serialiseProjectFile(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

export type ProjectFileParse =
  | { ok: true; project: ProjectFile }
  | { ok: false; reason: string };

/**
 * Reads a project file back.
 *
 * Validates rather than trusting: a file the user picked by mistake should produce a
 * clear sentence, not a crash or -- worse -- a dashboard of figures derived from
 * whatever happened to be in it.
 */
export function parseProjectFile(text: string): ProjectFileParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'That file is not valid JSON, so it is not a saved project.' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'That file does not contain a saved project.' };
  }

  const candidate = parsed as Partial<ProjectFile>;

  if (candidate.formatVersion !== PROJECT_FILE_VERSION) {
    return {
      ok: false,
      reason:
        `This project file is version ${String(candidate.formatVersion ?? 'unknown')}, and this ` +
        `version of the tool reads version ${String(PROJECT_FILE_VERSION)}. Re-create it from the original files.`,
    };
  }

  const data = candidate.data;
  if (
    !data ||
    !Array.isArray(data.bookRows) ||
    !Array.isArray(data.portalRows) ||
    !Array.isArray(data.imsRows) ||
    !Array.isArray(data.supplierMaster)
  ) {
    return { ok: false, reason: 'This project file is missing its data section.' };
  }

  return { ok: true, project: candidate as ProjectFile };
}

/** A filename that sorts sensibly and says what it is. */
export function projectFileName(asOf: string, buyerGstin: Gstin | null): string {
  const who = buyerGstin ? `-${buyerGstin}` : '';
  return `gst-vendor-scorecard${who}-${asOf}.json`;
}
