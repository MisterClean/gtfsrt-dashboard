// Getting from a blank page to an agency with days selected, as named steps. Each step
// has its own words, and a failure remembers which step it happened in, so a browser
// that can't start the engine is not told the archive's agency list is to blame.
import {EngineError, classifyError, friendlyError, type FriendlyError} from '../engine/errors.ts';

export type BootStep = 'engine' | 'catalog' | 'opening';
export type Boot =
  | {step: BootStep}
  | {step: 'ready'}
  | {step: 'failed'; at: BootStep; failure: EngineError};

export const BOOT_MESSAGE: Record<BootStep, string> = {
  engine: 'Starting the analysis engine…',
  catalog: 'Loading the agency list from the archive…',
  opening: 'Opening this agency…',
};

const CONTEXT: Record<BootStep, string> = {
  engine: 'starting the analysis engine',
  catalog: 'loading the archive catalog',
  opening: 'opening the agency',
};

/**
 * A startup failure in words. The engine is one of this site's own files, so when it
 * can't be fetched the archive is not to blame and no day is at stake. A browser that
 * can't run it, or a crash, already has words of its own.
 */
export function bootWords(boot: {at: BootStep; failure: EngineError}): FriendlyError {
  const friendly = friendlyError(boot.failure);
  if (boot.at === 'engine' && !['unsupported', 'engine_crash'].includes(boot.failure.kind)) {
    return {title: 'The analysis engine could not start.', advice: 'It is part of this site and runs inside your browser, so nothing can be analyzed until it loads. Check your connection and try again.', retryable: true};
  }
  if (boot.at === 'engine') return friendly;
  const note = boot.at === 'catalog' ? 'The agency list comes from the archive.' : 'The agency could not be opened.';
  return {...friendly, advice: `${friendly.advice} ${note}`};
}

export function bootFailed(at: BootStep, error: unknown): Boot {
  // The worker labels its errors with the call that failed ("calling catalog"). The step is
  // what the visitor was waiting for, so it replaces that label and the rest is kept.
  const found = classifyError(error);
  const failure = new EngineError(found.kind, found.message, {status: found.status, context: CONTEXT[at], detail: found.detail, cause: found.cause});
  return {step: 'failed', at, failure};
}

export const isBooting = (boot: Boot): boot is {step: BootStep} => boot.step !== 'ready' && boot.step !== 'failed';
