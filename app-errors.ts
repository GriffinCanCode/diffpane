export interface ErrorContext {
  code?: string;
  operation?: string;
  message?: string;
  recoverable?: boolean;
}

export interface ErrorDetails {
  code: string;
  operation?: string;
  message: string;
  recoverable: boolean;
}

export class AppError extends Error implements ErrorDetails {
  readonly code: string;
  readonly operation?: string;
  readonly recoverable: boolean;

  constructor(details: ErrorDetails, cause?: unknown) {
    super(details.message, { cause });
    this.name = 'AppError';
    this.code = details.code;
    this.operation = details.operation;
    this.recoverable = details.recoverable;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

function read(cause: unknown, property: keyof ErrorDetails): unknown {
  if (cause === null || (typeof cause !== 'object' && typeof cause !== 'function'))
    return undefined;
  // A thrown value can be a proxy or have a throwing getter.
  try {
    return Reflect.get(cause, property);
  } catch {
    return undefined;
  }
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function appError(cause: unknown, context: ErrorContext = {}): AppError {
  const details = serializeAppError(cause, context);
  try {
    if (
      cause instanceof AppError &&
      cause.message === details.message &&
      cause.code === details.code &&
      cause.operation === details.operation &&
      cause.recoverable === details.recoverable
    )
      return cause;
  } catch {
    // Revoked proxies can also throw during instanceof.
  }
  return new AppError(details, cause);
}

export function serializeAppError(cause: unknown, context: ErrorContext = {}): ErrorDetails {
  const recoverable = read(cause, 'recoverable');
  const message = nonempty(typeof cause === 'string' ? cause : read(cause, 'message'))?.replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    '',
  );
  return {
    message: nonempty(message) ?? context.message ?? 'An unexpected error occurred.',
    code: context.code ?? nonempty(read(cause, 'code')) ?? 'UNEXPECTED',
    operation: context.operation ?? nonempty(read(cause, 'operation')),
    recoverable: context.recoverable ?? (typeof recoverable === 'boolean' ? recoverable : true),
  };
}

export function attempt<T>(run: () => T, context?: ErrorContext): Result<T> {
  try {
    return { ok: true, value: run() };
  } catch (cause) {
    return { ok: false, error: appError(cause, context) };
  }
}

export async function attemptAsync<T>(
  run: () => T | PromiseLike<T>,
  context?: ErrorContext,
): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (cause) {
    return { ok: false, error: appError(cause, context) };
  }
}
