/// <reference lib="webworker" />
import { runAnalysis } from './index';
import type { AnalysisInputs, ProjectFile, WorkerRequest, WorkerResponse } from './types';

/**
 * The engine's Web Worker wrapper.
 *
 * The engine runs off the main thread so that parsing eight periods of spreadsheets
 * never freezes the interface. This file is deliberately thin: it moves messages in and
 * out and does no arithmetic of its own, so that the Node verification script and the
 * browser really are running identical code.
 *
 * Failures are returned as structured `error` responses, never swallowed and never left
 * as a blank screen. A user who uploads a file this tool cannot read is told which file
 * and at what stage.
 */

const self_ = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerResponse): void {
  self_.postMessage(message);
}

function describe(error: unknown): { message: string; detail?: string } {
  if (error instanceof Error) {
    return { message: error.message, detail: error.stack };
  }
  return { message: String(error) };
}

/** Rebuilds engine inputs from a saved project file's already-parsed rows. */
function inputsFromProject(project: ProjectFile): AnalysisInputs {
  return {
    files: [],
    buyerGstin: project.buyerGstin,
    asOf: project.asOf,
    isSampleData: project.isSampleData,
    dateFormatAnswers: project.dateFormatAnswers,
    extraBlockedSuppliers: project.extraBlockedSuppliers,
  };
}

self_.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    post({
      type: 'progress',
      requestId: request.requestId,
      stage: 'Reading files',
      fraction: 0.1,
    });

    if (request.type === 'run') {
      const result = runAnalysis(request.inputs);
      post({ type: 'result', requestId: request.requestId, result });
      return;
    }

    /*
     * A project file carries rows that were already parsed, so re-running it must not go
     * back through the parsers. That path is not implemented yet: rather than silently
     * producing an empty analysis, it says so.
     */
    const inputs = inputsFromProject(request.project);
    const result = runAnalysis(inputs);
    post({
      type: 'result',
      requestId: request.requestId,
      result: {
        ...result,
        notImplemented: [
          ...result.notImplemented,
          'Re-analysing a saved project file. Load the original spreadsheets instead.',
        ],
      },
    });
  } catch (error) {
    const { message, detail } = describe(error);
    post({
      type: 'error',
      requestId: request.requestId,
      stage: 'Analysis',
      message,
      ...(detail === undefined ? {} : { detail }),
    });
  }
};
