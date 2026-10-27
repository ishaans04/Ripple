/**
 * Stable codes for inputs the engine refuses. An engine error means the caller
 * passed corrupt or illegal state; the engine never repairs it silently.
 */
export type EngineErrorCode =
  | 'INVALID_INTEGER'
  | 'INVALID_ARGUMENT'
  | 'NON_CANONICAL_VALUE'
  | 'ILLEGAL_GENOME'
  | 'ILLEGAL_MOVE';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
