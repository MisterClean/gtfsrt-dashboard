// What can go wrong, in categories a visitor can act on. The worker classifies every
// failure once, ships the category with the original text across postMessage, and the
// page turns it into plain language. Kept free of DOM and worker globals so it can be
// unit tested in Node.

export type ErrorKind =
  | 'offline'          // no connection, or the request never reached the archive
  | 'timeout'          // the archive did not answer in time
  | 'http'             // the archive answered with an error status (403, 429, 5xx...)
  | 'archive_missing'  // the archive has no object for what was asked
  | 'schedule'         // the schedule could not be read or joined to the positions
  | 'memory'           // DuckDB or the browser ran out of memory
  | 'query'            // DuckDB rejected or failed a query
  | 'cache'            // IndexedDB is unavailable, blocked or full
  | 'unsupported'      // the browser lacks something the engine needs
  | 'engine_crash'     // the worker itself died
  | 'cancelled'        // the visitor stopped the run
  | 'unknown';

/** The shape that crosses postMessage. Errors themselves do not survive it with their cause. */
export interface SerializedError {
  kind: ErrorKind;
  message: string;
  status?: number;
  /** Where it happened, e.g. "reading the 2026-11-06 archive file". */
  context?: string;
  /** Original error name and stack, for the details disclosure and bug reports. */
  detail?: string;
}

export class EngineError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly context?: string;
  readonly detail?: string;

  constructor(kind: ErrorKind, message: string, options: {status?: number; context?: string; detail?: string; cause?: unknown} = {}) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause});
    this.name = 'EngineError';
    this.kind = kind;
    this.status = options.status;
    this.context = options.context;
    this.detail = options.detail;
  }
}

export interface FriendlyError {
  title: string;
  /** What the visitor can do about it. */
  advice: string;
  /** Whether trying again has any chance of working. */
  retryable: boolean;
}

const OFFLINE = /failed to fetch|networkerror|load failed|network request failed|net::err_|network error/i;
const MEMORY = /out of memory|memory_limit|memory limit|std::bad_alloc|allocation failed|invalid array length|rangeerror.*memory/i;
const DUCKDB = /\b(IO|Binder|Catalog|Parser|Invalid Input|Conversion|Constraint|Out of Range|Invalid|Serialization|Internal|Not implemented) Error\b|duckdb|parquet/i;
const CACHE = /indexeddb|quotaexceeded|saved results|storage is full/i;
const SCHEDULE = /schedule/i;

function cause(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  return String(error);
}

/** Turns anything thrown into a categorised error that keeps the original as its cause. */
export function classifyError(error: unknown, context?: string): EngineError {
  if (error instanceof EngineError) return error;
  const text = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const options = {context, detail: cause(error), cause: error};
  if (name === 'AbortError' && !/timeout/i.test(text)) return new EngineError('cancelled', text, options);
  if (name === 'TimeoutError' || /timed? ?out|timeout/i.test(text)) return new EngineError('timeout', text, options);
  const status = /HTTP (\d{3})/i.exec(text)?.[1];
  if (status) return new EngineError('http', text, {...options, status: Number(status)});
  if (MEMORY.test(text) || (name === 'RangeError' && /memory|array/i.test(text))) return new EngineError('memory', text, options);
  if (/needs WebAssembly|WebAssembly is not supported/i.test(text)) return new EngineError('unsupported', text, options);
  if (CACHE.test(text) || name === 'QuotaExceededError') return new EngineError('cache', text, options);
  if (OFFLINE.test(text) || (name === 'TypeError' && /fetch/i.test(text))) return new EngineError('offline', text, options);
  if (/no vehicle data|has no .* archive|outside the dates/i.test(text)) return new EngineError('archive_missing', text, options);
  if (DUCKDB.test(text)) return new EngineError('query', text, options);
  if (SCHEDULE.test(text)) return new EngineError('schedule', text, options);
  return new EngineError('unknown', text, options);
}

/**
 * Whether a failure is about the connection or the archive's availability right now,
 * rather than about the data. Trying again can fix these, so they must never be turned
 * into a quieter result (such as a day measured from GPS alone) that gets saved.
 */
export function isTransient(error: EngineError): boolean {
  switch (error.kind) {
    case 'offline':
    case 'timeout':
      return true;
    case 'http':
      // A 404 or 410 is a statement about the object. Everything else is trouble that passes.
      return error.status !== 404 && error.status !== 410;
    default:
      return false;
  }
}

export function serializeError(error: unknown, context?: string): SerializedError {
  const classified = classifyError(error, context);
  return {
    kind: classified.kind,
    message: classified.message,
    status: classified.status,
    context: classified.context ?? context,
    detail: classified.detail ?? classified.stack,
  };
}

/** Rebuilds an error on the page side, keeping the worker's text as the cause. */
export function reviveError(data: SerializedError | string): EngineError {
  if (typeof data === 'string') return classifyError(new Error(data));
  const cause = new Error(data.message);
  if (data.detail) cause.stack = data.detail;
  return new EngineError(data.kind, data.message, {status: data.status, context: data.context, detail: data.detail, cause});
}

export function friendlyError(error: EngineError): FriendlyError {
  switch (error.kind) {
    case 'offline':
      return {title: "Couldn't reach the archive.", advice: 'Check your internet connection, then try again. Days already finished are kept.', retryable: true};
    case 'timeout':
      return {title: 'The archive took too long to answer.', advice: 'The connection may be slow or busy. Try again in a moment.', retryable: true};
    case 'http':
      if (error.status === 403) return {title: 'The archive refused the request (HTTP 403).', advice: 'Access may be blocked by a network filter or an expired link. Try another network, or try again later.', retryable: true};
      if (error.status === 429) return {title: 'The archive is asking for fewer requests (HTTP 429).', advice: 'Wait a minute and try again.', retryable: true};
      if (error.status && error.status >= 500) return {title: `The archive had a problem (HTTP ${error.status}).`, advice: 'This is on the archive side. Try again in a few minutes.', retryable: true};
      return {title: `The archive returned an error (HTTP ${error.status ?? '?'}).`, advice: 'Try again. If it keeps happening, the details below help a bug report.', retryable: true};
    case 'archive_missing':
      return {title: 'The archive has nothing for that day.', advice: 'Pick another day. The calendar only offers days this agency has in the archive.', retryable: false};
    case 'schedule':
      return {title: "This agency's schedule couldn't be read or matched.", advice: 'Speeds can still be shown from GPS positions alone. Try again, or choose different days.', retryable: true};
    case 'memory':
      return {title: 'This agency is too large to analyze in the memory this tab has.', advice: 'Try fewer days at a time, close other tabs, or use a desktop browser. Days already finished are kept.', retryable: true};
    case 'query':
      return {title: 'The local database could not read this data.', advice: 'Try again. If it keeps failing, report it with the details below.', retryable: true};
    case 'cache':
      return {title: "This browser can't save results.", advice: 'Storage may be full, blocked, or turned off in a private window. Results will work for this visit but must be analyzed again next time.', retryable: false};
    case 'unsupported':
      return {title: "This browser can't run the analysis engine.", advice: 'Use a current version of Chrome, Edge, Firefox or Safari.', retryable: false};
    case 'engine_crash':
      return {title: 'The analysis engine stopped unexpectedly.', advice: 'Reload the page to restart it. The URL keeps your agency and days, and finished days load from this device.', retryable: false};
    case 'cancelled':
      return {title: 'Stopped.', advice: 'Days already finished are still here.', retryable: true};
    default:
      return {title: 'Something went wrong.', advice: 'Try again. If it keeps happening, copy the details below into a bug report.', retryable: true};
  }
}

/** Plain-text block for the details disclosure. */
export function errorDetails(error: EngineError): string {
  const lines = [`Category: ${error.kind}`];
  if (error.status) lines.push(`HTTP status: ${error.status}`);
  if (error.context) lines.push(`While: ${error.context}`);
  lines.push(`Message: ${error.message}`);
  if (error.detail && error.detail !== error.message) lines.push('', error.detail);
  return lines.join('\n');
}
