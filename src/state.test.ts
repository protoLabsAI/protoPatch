import { describe, expect, it } from "vitest";
import { isStaleLocalFeatureLock, readFeature, readFinding, statePaths } from "./state.js";

describe("state record paths", () => {
  it("rejects path-like record IDs before filesystem access", async () => {
    const paths = statePaths("/missing/state");

    await expect(readFinding(paths, "../project")).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(readFeature(paths, "nested/feature")).rejects.toMatchObject({
      code: "invalid-input",
    });
  });
});

describe("isStaleLocalFeatureLock", () => {
  it("decides lock staleness by pid on the same host and by age on another host", () => {
    const now = Date.parse("2026-09-29T23:00:00Z");
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const opts = (alive: boolean) => ({
      hostname: "here",
      isPidAlive: () => alive,
      maxForeignLockAgeMs: 120 * 60_000,
      now: () => now,
    });
    const lock = (hostname: string, minutesAgo: number) => ({
      lockedByRunId: "r",
      lockedAt: at(minutesAgo),
      hostname,
      pid: 1,
    });
    // Same host: pid decides, age never does.
    expect(isStaleLocalFeatureLock(lock("here", 600), opts(true))).toBe(false);
    expect(isStaleLocalFeatureLock(lock("here", 1), opts(false))).toBe(true);
    // Another host: fresh stays, aged is reclaimed, unparseable lockedAt stays.
    expect(isStaleLocalFeatureLock(lock("there", 30), opts(false))).toBe(false);
    expect(isStaleLocalFeatureLock(lock("there", 121), opts(false))).toBe(true);
    expect(
      isStaleLocalFeatureLock({ ...lock("there", 0), lockedAt: "not-a-date" }, opts(false)),
    ).toBe(false);
  });
});
