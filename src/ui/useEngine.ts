import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnalysisInputs,
  AnalysisResult,
  InputFile,
  SlashDateFormatAnswers,
  WorkerRequest,
  WorkerResponse,
} from '../engine/types';
import {
  SAMPLE_AS_OF,
  SAMPLE_BUYER_GSTIN,
  SAMPLE_FILES,
  type SampleFileEntry,
} from '../fixtures/sampleBundle';

/**
 * Owns the Web Worker and the single AnalysisResult the whole interface renders from.
 *
 * The engine runs off the main thread, so a large register never freezes the page. This
 * hook does no arithmetic: it sends inputs in and hands the result out.
 */

export type EngineState =
  | { status: 'idle' }
  | { status: 'running'; stage: string; fraction: number }
  | { status: 'ready'; result: AnalysisResult }
  | { status: 'error'; message: string; stage: string; detail?: string };

/**
 * Decodes a base64 payload from the bundled sample into bytes.
 *
 * The sample files are embedded in the bundle rather than fetched. Fetching them, even
 * from this app's own origin, would be a network request -- which the Content-Security-
 * Policy forbids and the lint rules will not compile. So they are decoded here and fed
 * through exactly the same parsers a user's own upload goes through.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function sampleEntryToInputFile(entry: SampleFileEntry): InputFile {
  return {
    kind: entry.kind,
    fileName: entry.fileName,
    period: entry.period,
    content: entry.base64 === undefined ? (entry.text ?? '') : base64ToArrayBuffer(entry.base64),
  };
}

export function sampleInputs(dateFormatAnswers?: SlashDateFormatAnswers): AnalysisInputs {
  return {
    files: SAMPLE_FILES.map(sampleEntryToInputFile),
    buyerGstin: SAMPLE_BUYER_GSTIN,
    // Pinned, not today's date: the sample's figures must not drift over time.
    asOf: SAMPLE_AS_OF,
    isSampleData: true,
    ...(dateFormatAnswers ? { dateFormatAnswers } : {}),
  };
}

let requestCounter = 0;

export function useEngine() {
  const [state, setState] = useState<EngineState>({ status: 'idle' });
  const workerRef = useRef<Worker | null>(null);
  const activeRequestRef = useRef<string | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      // Ignore anything from a run the user has already superseded.
      if (message.requestId !== activeRequestRef.current) return;

      if (message.type === 'progress') {
        setState({ status: 'running', stage: message.stage, fraction: message.fraction });
        return;
      }
      if (message.type === 'result') {
        setState({ status: 'ready', result: message.result });
        return;
      }
      setState({
        status: 'error',
        message: message.message,
        stage: message.stage,
        ...(message.detail === undefined ? {} : { detail: message.detail }),
      });
    };

    // A worker that fails to start is reported, never silently absent.
    worker.onerror = (event) => {
      setState({
        status: 'error',
        stage: 'Starting the analysis engine',
        message: event.message || 'The analysis engine could not be started.',
      });
    };

    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = useCallback((inputs: AnalysisInputs) => {
    const worker = workerRef.current;
    if (!worker) {
      setState({
        status: 'error',
        stage: 'Starting the analysis engine',
        message: 'The analysis engine is not running.',
      });
      return;
    }

    requestCounter += 1;
    const requestId = `r${String(requestCounter)}`;
    activeRequestRef.current = requestId;

    setState({ status: 'running', stage: 'Reading files', fraction: 0.05 });
    const request: WorkerRequest = { type: 'run', requestId, inputs };
    worker.postMessage(request);
  }, []);

  const runSample = useCallback(
    (dateFormatAnswers?: SlashDateFormatAnswers) => {
      run(sampleInputs(dateFormatAnswers));
    },
    [run],
  );

  const reset = useCallback(() => {
    activeRequestRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, run, runSample, reset };
}
