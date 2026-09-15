import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as appTesting, AppContext } from "./app.js";
import { ClawpatchError } from "./errors.js";
import { providerByName } from "./provider.js";
import type { ReviewOutput } from "./types.js";

// eslint-disable-next-line no-underscore-dangle
const { isRetryableReviewError, reviewRetries, runProviderReviewWithRetry } = appTesting;

const QUIET_CONTEXT: AppContext = {
  root: "/tmp/test-root",
  options: {
    root: "/tmp/test-root",
    json: false,
    plain: false,
    quiet: true,
    verbose: false,
    debug: false,
    noColor: true,
    noInput: true,
  },
};

function emptyReview(): ReviewOutput {
  return { findings: [], inspected: { files: [], symbols: [], notes: ["ok"] } };
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("isRetryableReviewError", () => {
  it("returns true for malformed-output ClawpatchError", () => {
    expect(isRetryableReviewError(new ClawpatchError("bad", 8, "malformed-output"))).toBe(true);
  });

  it("returns false for provider-auth", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 4, "provider-auth"))).toBe(false);
  });

  it("returns false for unsupported-provider", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 2, "unsupported-provider"))).toBe(
      false,
    );
  });

  it("returns false for agent-refused", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 1, "agent-refused"))).toBe(false);
  });

  it("returns false for agent-cancelled", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 1, "agent-cancelled"))).toBe(false);
  });

  it("returns false for provider-failure (acpx-layer handles those)", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 1, "provider-failure"))).toBe(false);
  });

  it("returns true for a provider-failure the provider marked retryable", () => {
    const error = new ClawpatchError("truncated", 4, "provider-failure", { retryable: true });
    expect(isRetryableReviewError(error)).toBe(true);
    // retryability never changes the exit-code / error-class contract
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("provider-failure");
  });

  it("returns false for plain Error", () => {
    expect(isRetryableReviewError(new Error("oops"))).toBe(false);
  });
});

describe("reviewRetries", () => {
  afterEach(() => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
  });

  it("defaults to 1", () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    expect(reviewRetries()).toBe(1);
  });

  it("respects 0 (disables retry)", () => {
    withEnv("CLAWPATCH_REVIEW_RETRIES", "0", () => {
      expect(reviewRetries()).toBe(0);
    });
  });

  it("respects positive integer override", () => {
    withEnv("CLAWPATCH_REVIEW_RETRIES", "2", () => {
      expect(reviewRetries()).toBe(2);
    });
  });

  it("falls back to 1 on garbage input", () => {
    withEnv("CLAWPATCH_REVIEW_RETRIES", "abc", () => {
      expect(reviewRetries()).toBe(1);
    });
  });
});

function fakeProvider(reviewImpl: (...args: unknown[]) => Promise<ReviewOutput>): {
  name: string;
  check: () => Promise<string>;
  map: () => Promise<never>;
  review: (...args: unknown[]) => Promise<ReviewOutput>;
  fix: () => Promise<never>;
  revalidate: () => Promise<never>;
} {
  return {
    name: "fake",
    async check(): Promise<string> {
      return "fake";
    },
    async map(): Promise<never> {
      throw new Error("not used");
    },
    review: reviewImpl,
    async fix(): Promise<never> {
      throw new Error("not used");
    },
    async revalidate(): Promise<never> {
      throw new Error("not used");
    },
  };
}

describe("runProviderReviewWithRetry", () => {
  afterEach(() => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
  });

  it("returns output on first try without retry", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const review = vi.fn().mockResolvedValue(emptyReview());
    const provider = fakeProvider(review);
    const result = await runProviderReviewWithRetry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: provider as any,
      root: "/tmp",
      prompt: "hi",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: {} as any,
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
    });
    expect(result.findings).toEqual([]);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("retries once on malformed-output then succeeds", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const review = vi
      .fn()
      .mockRejectedValueOnce(new ClawpatchError("garbled", 8, "malformed-output"))
      .mockResolvedValueOnce(emptyReview());
    const provider = fakeProvider(review);
    const result = await runProviderReviewWithRetry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: provider as any,
      root: "/tmp",
      prompt: "hi",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: {} as any,
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
    });
    expect(result.findings).toEqual([]);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("acquires the RPM limiter before each retry attempt", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const review = vi
      .fn()
      .mockRejectedValueOnce(new ClawpatchError("garbled", 8, "malformed-output"))
      .mockResolvedValueOnce(emptyReview());
    const acquire = vi.fn().mockResolvedValue(undefined);
    const provider = fakeProvider(review);
    await runProviderReviewWithRetry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: provider as any,
      root: "/tmp",
      prompt: "hi",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: {} as any,
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
      limiter: { acquire },
    });
    expect(review).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on provider-auth", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const err = new ClawpatchError("auth", 4, "provider-auth");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on agent-cancelled", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const err = new ClawpatchError("cancel", 1, "agent-cancelled");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("respects CLAWPATCH_REVIEW_RETRIES=0 (no retry, malformed-output fails on first attempt)", async () => {
    process.env["CLAWPATCH_REVIEW_RETRIES"] = "0";
    const err = new ClawpatchError("garbled", 8, "malformed-output");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("passes every attempt the first attempt's start as callStartedAt", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const review = vi
      .fn()
      .mockRejectedValueOnce(new ClawpatchError("garbled", 8, "malformed-output"))
      .mockResolvedValueOnce(emptyReview());
    const before = Date.now();
    await runProviderReviewWithRetry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: fakeProvider(review) as any,
      root: "/tmp",
      prompt: "hi",
      options: { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
    });
    const starts = review.mock.calls.map(
      (call) => (call[2] as { callStartedAt?: number }).callStartedAt,
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBeGreaterThanOrEqual(before);
    expect(starts[1]).toBe(starts[0]);
  });

  it("re-throws after maxAttempts when malformed-output persists", async () => {
    process.env["CLAWPATCH_REVIEW_RETRIES"] = "1";
    const err = new ClawpatchError("garbled", 8, "malformed-output");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(2);
  });
});

function gatewayReply(content: string, finishReason: string): string {
  return JSON.stringify({
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    usage: { completion_tokens: 32000 },
  });
}

function stubGatewayFetch(...bodies: string[]) {
  const queue = [...bodies];
  const fetchMock = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(next, { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// End to end through the real gateway provider with fetch stubbed: an
// unusable reply (truncated at the output limit) is retried within
// CLAWPATCH_REVIEW_RETRIES, and an exhausted retry still exits 4 /
// provider-failure — the contract pr-reviewer maps exit codes from.
describe("runProviderReviewWithRetry with the gateway provider", () => {
  const ENV_KEYS = [
    "GATEWAY_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CLAWPATCH_GATEWAY_MAX_TOKENS",
    "CLAWPATCH_REVIEW_RETRIES",
  ] as const;
  const snapshot: Record<string, string | undefined> = {};

  const CLEAN = JSON.stringify({
    findings: [],
    inspected: { files: [], symbols: [], notes: ["ok"] },
  });

  function run() {
    return runProviderReviewWithRetry({
      provider: providerByName("gateway"),
      root: "/tmp",
      prompt: "review this",
      options: { model: null, reasoningEffort: null, skipGitRepoCheck: false },
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
    });
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env["GATEWAY_API_KEY"] = "k";
    process.env["OPENAI_BASE_URL"] = "https://gateway.test/v1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("does not retry a truncated reply (the same cap would cut it off again)", async () => {
    const fetchMock = stubGatewayFetch(
      gatewayReply(CLEAN.slice(0, 20), "length"),
      gatewayReply(CLEAN, "stop"),
    );
    const error = await run().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ClawpatchError);
    expect((error as ClawpatchError).exitCode).toBe(4);
    expect((error as ClawpatchError).code).toBe("provider-failure");
    expect((error as ClawpatchError).message).toContain("response truncated at the output limit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an unparseable reply the same way", async () => {
    const fetchMock = stubGatewayFetch(
      gatewayReply("{ not json at all", "stop"),
      gatewayReply(CLEAN, "stop"),
    );
    const result = await run();
    expect(result.findings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps exit 4 / provider-failure when the retry budget is exhausted", async () => {
    process.env["CLAWPATCH_REVIEW_RETRIES"] = "1";
    const fetchMock = stubGatewayFetch(gatewayReply("{ not json at all", "stop"));
    const error = await run().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ClawpatchError);
    expect((error as ClawpatchError).exitCode).toBe(4);
    expect((error as ClawpatchError).code).toBe("provider-failure");
    expect((error as ClawpatchError).message).toContain("response was not parseable JSON");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when CLAWPATCH_REVIEW_RETRIES=0", async () => {
    process.env["CLAWPATCH_REVIEW_RETRIES"] = "0";
    const fetchMock = stubGatewayFetch(
      gatewayReply("{ not json at all", "stop"),
      gatewayReply(CLEAN, "stop"),
    );
    await expect(run()).rejects.toThrow("response was not parseable JSON");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
