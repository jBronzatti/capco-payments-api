const REDACTED = '[REDACTED]';
// A CPF, masked or not, standing alone (not part of a longer digit run such as a UUID group).
const CPF_SHAPED = /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/g;
const MAX_CAUSE_DEPTH = 5;

export interface SerializedError {
  type: string;
  code?: string;
  model?: string;
  stack?: string;
  cause?: SerializedError;
}

/**
 * Database and driver errors embed row values ("Failing row contains (...)") in their messages and metadata.
 * Only the type, the error code, the model name and stack frames are kept; messages and metadata are dropped.
 */
export function serializeError(error: unknown): SerializedError {
  return serializeAtDepth(error, 0);
}

function serializeAtDepth(error: unknown, depth: number): SerializedError {
  if (!(error instanceof Error)) return { type: typeof error };
  const { code, meta } = error as { code?: unknown; meta?: { modelName?: unknown } };
  const followCause = error.cause !== undefined && depth < MAX_CAUSE_DEPTH;
  return {
    type: error.name,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof meta?.modelName === 'string' ? { model: meta.modelName } : {}),
    ...(error.stack ? { stack: stackFramesOnly(error.stack) } : {}),
    ...(followCause ? { cause: serializeAtDepth(error.cause, depth + 1) } : {}),
  };
}

function stackFramesOnly(stack: string): string {
  return stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
}

export interface SerializedRequest {
  id: unknown;
  method: string;
  path: string;
  queryKeys: string[];
}

/** Path and query keys only: query values are never logged, and CPF-shaped segments are redacted. */
export function serializeRequest(req: { id: unknown; method: string; url: string }): SerializedRequest {
  const [rawPath = '', rawQuery = ''] = req.url.split('?', 2);
  const queryKeys = [...new URLSearchParams(rawQuery).keys()].map(redactCpf);
  const path = rawPath.split('/').map(decodeSegment).map(redactCpf).join('/');
  return { id: req.id, method: req.method, path, queryKeys };
}

function redactCpf(text: string): string {
  return text.replace(CPF_SHAPED, REDACTED);
}

// Fails closed: a segment that cannot be decoded is not logged at all.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return REDACTED;
  }
}
