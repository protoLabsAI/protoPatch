export type ClawpatchErrorOptions = {
  /**
   * Marks the failure as transient: the review loop may retry it within the
   * `CLAWPATCH_REVIEW_RETRIES` budget. Retryability never changes `exitCode`
   * or `code` — callers (e.g. pr-reviewer) key off those, so an error that
   * exhausts its retries surfaces exactly as it would have without them.
   */
  retryable?: boolean;
};

export class ClawpatchError extends Error {
  public readonly exitCode: number;
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    exitCode = 1,
    code = "runtime",
    options: ClawpatchErrorOptions = {},
  ) {
    super(message);
    this.name = "ClawpatchError";
    this.exitCode = exitCode;
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ClawpatchError(message);
  }
  return value;
}
