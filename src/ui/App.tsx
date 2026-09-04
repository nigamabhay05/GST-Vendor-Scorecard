import { useCallback, useMemo, useState } from 'react';
import type {
  FileKind,
  FileMapping,
  ProjectFile,
  SlashDateFormatAnswers,
} from '../engine/types';
import { Rail } from './components/Rail';
import { Notice } from './components/primitives';
import { DataHealth } from './screens/DataHealth';
import { Exports } from './screens/Exports';
import {
  Files,
  readPendingFiles,
  toInputFiles,
  type PendingFile,
} from './screens/Files';
import { Findings } from './screens/Findings';
import { Scorecard } from './screens/Scorecard';
import { Start } from './screens/Start';
import { SupplierDetail } from './screens/SupplierDetail';
import type { ScreenId } from './screens/screens';
import { sampleInputs, useEngine } from './useEngine';

/**
 * The application shell.
 *
 * State here is navigation and inputs only. Every business figure comes from the single
 * AnalysisResult the engine returns; this component never computes one.
 */
export function App() {
  const { state, run, runSample } = useEngine();

  const [screen, setScreen] = useState<ScreenId>('start');
  const [openSupplier, setOpenSupplier] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [mappings, setMappings] = useState<Map<string, FileMapping>>(new Map());
  const [dateAnswers, setDateAnswers] = useState<SlashDateFormatAnswers>({});
  const [healthAcknowledged, setHealthAcknowledged] = useState(false);
  const [isSample, setIsSample] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const result = state.status === 'ready' ? state.result : null;
  const busy = state.status === 'running';
  const blocked = result?.dataHealth.blocking ?? false;

  const available = useMemo(() => {
    const set = new Set<ScreenId>(['start', 'files']);
    if (result) {
      set.add('dataHealth');
      if (healthAcknowledged && !blocked) {
        set.add('scorecard');
        set.add('findings');
        set.add('exports');
      }
    }
    return set;
  }, [result, healthAcknowledged, blocked]);

  const analyseUploads = useCallback(
    (answers: SlashDateFormatAnswers = dateAnswers) => {
      setIsSample(false);
      setHealthAcknowledged(false);
      run({
        files: toInputFiles(pendingFiles, mappings),
        buyerGstin: null,
        // The user's own data is measured against today, unlike the pinned sample.
        asOf: new Date().toISOString().slice(0, 10),
        isSampleData: false,
        dateFormatAnswers: answers,
      });
      setScreen('dataHealth');
    },
    [dateAnswers, mappings, pendingFiles, run],
  );

  const loadSample = useCallback(() => {
    setIsSample(true);
    setHealthAcknowledged(false);
    setDateAnswers({});
    runSample();
    setScreen('dataHealth');
  }, [runSample]);

  const handleResolveDateFormat = useCallback(
    (answers: SlashDateFormatAnswers) => {
      const merged = { ...dateAnswers, ...answers };
      setDateAnswers(merged);
      if (isSample) {
        run(sampleInputs(merged));
      } else {
        analyseUploads(merged);
      }
    },
    [analyseUploads, dateAnswers, isSample, run],
  );

  const buildProject = useCallback((): ProjectFile | null => {
    if (!result) return null;
    /*
     * Saving needs the parsed rows, which live inside the worker's run rather than on
     * this side of the boundary. Rather than shipping an incomplete file that silently
     * loses data, this says so.
     */
    setLoadError(
      'Saving a project needs the parsed rows, which are not yet passed back from the ' +
        'analysis engine. Use the CSV exports for now.',
    );
    return null;
  }, [result]);

  const handleAddFiles = useCallback((kind: FileKind, list: FileList) => {
    void readPendingFiles(kind, list).then((added) => {
      setPendingFiles((existing) => [
        ...existing.filter((file) => !added.some((entry) => entry.fileName === file.fileName)),
        ...added,
      ]);
    });
  }, []);

  return (
    <div className="bg-sheet flex min-h-screen">
      <Rail
        current={screen}
        onNavigate={(next) => {
          setOpenSupplier(null);
          setScreen(next);
        }}
        available={available}
        blocked={blocked}
      />

      <main className="min-w-0 flex-1">
        {state.status === 'error' && (
          <div className="px-6 pt-6">
            <Notice tone="error" title={`Could not finish: ${state.stage}`}>
              {state.message}
            </Notice>
          </div>
        )}

        {loadError && (
          <div className="px-6 pt-6">
            <Notice tone="warning" title="Not available yet">
              {loadError}
            </Notice>
          </div>
        )}

        {busy && (
          <div className="px-6 pt-6">
            <Notice title={state.status === 'running' ? state.stage : 'Working'}>
              Processing in this browser. Nothing is uploaded.
            </Notice>
          </div>
        )}

        {screen === 'start' && (
          <Start
            onLoadSample={loadSample}
            onUpload={() => {
              setScreen('files');
            }}
            busy={busy}
          />
        )}

        {screen === 'files' && (
          <Files
            files={pendingFiles}
            onAddFiles={handleAddFiles}
            onRemoveFile={(fileName) => {
              setPendingFiles((existing) => existing.filter((file) => file.fileName !== fileName));
            }}
            onSetPeriod={(fileName, period) => {
              setPendingFiles((existing) =>
                existing.map((file) =>
                  file.fileName === fileName ? { ...file, period: period || null } : file,
                ),
              );
            }}
            onAnalyse={() => {
              analyseUploads();
            }}
            onUpdateMapping={(mapping) => {
              setMappings((existing) => new Map(existing).set(mapping.fileName, mapping));
            }}
            result={result}
            busy={busy}
          />
        )}

        {screen === 'dataHealth' &&
          (result ? (
            <DataHealth
              result={result}
              acknowledged={healthAcknowledged}
              onAcknowledge={setHealthAcknowledged}
              onResolveDateFormat={handleResolveDateFormat}
              onContinue={() => {
                setScreen('scorecard');
              }}
            />
          ) : (
            <div className="px-6 py-6">
              <Notice title="Nothing has been analysed yet">
                Load the sample data or add your own files first.
              </Notice>
            </div>
          ))}

        {screen === 'scorecard' &&
          result &&
          (openSupplier ? (
            <SupplierDetail
              result={result}
              supplierKey={openSupplier}
              onBack={() => {
                setOpenSupplier(null);
              }}
            />
          ) : (
            <Scorecard result={result} onOpenSupplier={setOpenSupplier} />
          ))}

        {screen === 'findings' && result && <Findings result={result} />}

        {screen === 'exports' && result && (
          <Exports result={result} buildProject={buildProject} />
        )}
      </main>
    </div>
  );
}
