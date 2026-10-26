export class SurfError extends Error {
  readonly hint?: string;
  readonly exitCode: number;
  readonly status?: number;
  readonly retryable?: boolean;

  constructor(
    message: string,
    options: {
      hint?: string;
      exitCode?: number;
      cause?: unknown;
      status?: number;
      retryable?: boolean;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'SurfError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // AbortSignal.timeout() uses TimeoutError, which is retryable. It must not
  // be mistaken for a user cancellation just because its message says
  // "aborted due to timeout".
  if (error.name === 'TimeoutError') return false;
  if (error.name === 'AbortError') return true;
  return /(?:request|operation|signal) aborted/i.test(error.message) && !/timeout/i.test(error.message);
}
