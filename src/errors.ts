export type ClawpatchErrorOptions = {
  /**
   * Whether the review loop may retry this failure within the
   * `CLAWPATCH_REVIEW_RETRIES` budget: `true` = transient, retry it; `false` =
   * do not, even when its code is normally retried (e.g. no time is left for
   * another attempt); unset = the code decides. Retryability never changes
   * `exitCode` or `code` — callers (e.g. pr-reviewer) key off those, so an
   * error that exhausts its retries surfaces exactly as it would without them.
   */
  retryable?: boolean;
  /**
   * The failure is a call's shared deadline running out (see
   * `ProviderOptions.callStartedAt`), not something the provider said.
   */
  deadlineExceeded?: boolean;
};

export class ClawpatchError extends Error {
  public readonly exitCode: number;
  public readonly code: string;
  public readonly retryable: boolean | undefined;
  public readonly deadlineExceeded: boolean;

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
    this.retryable = options.retryable;
    this.deadlineExceeded = options.deadlineExceeded === true;
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ClawpatchError(message);
  }
  return value;
}
