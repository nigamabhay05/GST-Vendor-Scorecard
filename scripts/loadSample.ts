/**
 * Loads the committed sample dataset from disk into engine inputs.
 *
 * Kept separate from verify-fixture.ts so tests and diagnostics can import it without
 * running that script&apos;s report as a side effect.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_AS_OF, SAMPLE_BUYER_GSTIN } from '../src/fixtures/sampleBundle';
import type { AnalysisInputs, FileKind, InputFile } from '../src/engine/types';
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(HERE, '..', 'src', 'fixtures', 'sample');

function kindOf(fileName: string): FileKind | null {
  if (fileName.startsWith('purchase-register-')) return 'purchaseRegister';
  if (fileName.startsWith('gstr2b-')) return 'gstr2b';
  if (fileName.startsWith('ims-log-')) return 'imsLog';
  if (fileName.startsWith('supplier-master')) return 'supplierMaster';
  return null;
}

function periodOf(fileName: string): string | null {
  return /(\d{4}-\d{2})/.exec(fileName)?.[1] ?? null;
}

export function loadSampleInputs(): AnalysisInputs {
  const files: InputFile[] = [];

  for (const fileName of readdirSync(SAMPLE_DIR).sort()) {
    const kind = kindOf(fileName);
    if (!kind) continue;

    const path = join(SAMPLE_DIR, fileName);

    if (fileName.endsWith('.xlsx')) {
      const buffer = readFileSync(path);
      // A copy, so the ArrayBuffer really is just the file's bytes.
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
      files.push({ kind, fileName, period: periodOf(fileName), content: arrayBuffer });
    } else {
      files.push({
        kind,
        fileName,
        period: periodOf(fileName),
        content: readFileSync(path, 'utf8'),
      });
    }
  }

  return {
    files,
    buyerGstin: SAMPLE_BUYER_GSTIN,
    asOf: SAMPLE_AS_OF,
    isSampleData: true,
  };
}

