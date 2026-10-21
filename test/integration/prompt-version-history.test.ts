import { describe, expect, test } from "vitest";

import { SessionVersionHistory } from "../../src/prompt-version-history.js";
import type { PromptVersionValue } from "../../src/prompt-versions.js";

const at = (version: number): PromptVersionValue => ({
  release: `policy/AGENTS@${version.toString()}`,
  agentsMdStatus: "matched",
  agentsMdVersion: version,
  agentsMdChanged: false,
  otherInstructionCount: 0,
});
const A = at(7);
const B = at(8);

const createHistory = (
  options: Partial<ConstructorParameters<typeof SessionVersionHistory>[0]> = {},
) => {
  const clock = { now: 0 };
  const history = new SessionVersionHistory({
    startedAtMs: 0,
    now: () => clock.now,
    ...options,
  });
  const finishAt = (
    time: number,
    value: PromptVersionValue,
    session = "s",
    entry = `e${time.toString()}`,
  ) => {
    clock.now = time;
    history.finish(session, entry, value);
  };
  return { clock, history, finishAt };
};

describe("SessionVersionHistory", () => {
  test("merges equal consecutive values into one run", () => {
    const { history, finishAt } = createHistory();
    finishAt(1, A);
    finishAt(2, A);
    finishAt(3, A);

    expect(history.debugSize("s").runs).toBe(1);
    expect(history.summarize("s", 0, 9)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("uses only determinations inside the window", () => {
    const { history, finishAt } = createHistory();
    finishAt(12, A);
    finishAt(20, B);

    expect(history.summarize("s", 15, 25)).toEqual({
      kind: "window",
      values: [B],
    });
    expect(history.summarize("s", 5, 25)).toEqual({
      kind: "window",
      values: [A, B],
    });
    expect(history.summarize("s", 30, 40)).toEqual({
      kind: "latest",
      value: B,
    });
    expect(history.summarize("s", 13, 19)).toEqual({
      kind: "latest",
      value: A,
    });
    expect(history.summarize("s", 5, 11)).toEqual({ kind: "none" });
  });

  test("is exact for a run spanning the window", () => {
    const { history, finishAt } = createHistory();
    finishAt(10, A);
    finishAt(30, A);

    expect(history.summarize("s", 15, 20)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("is unavailable when the window starts before the process started", () => {
    const { history, finishAt } = createHistory({ startedAtMs: 100 });
    finishAt(150, A);

    expect(history.summarize("s", 50, 200)).toEqual({ kind: "unavailable" });
  });

  test("is unavailable while any generation is pending", () => {
    const { history, finishAt, clock } = createHistory();
    finishAt(10, A, "s", "A");
    history.begin("s", "B");

    expect(history.debugSize("s").pending).toBe(1);
    expect(history.summarize("s", 5, 30)).toEqual({ kind: "unavailable" });
    expect(history.summarize("s", 11, 30)).toEqual({ kind: "unavailable" });

    clock.now = 20;
    history.finish("s", "B", A);
    expect(history.summarize("s", 5, 30)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("stays bounded for a long same-value sequence", () => {
    const { history, clock } = createHistory();
    for (let index = 0; index < 10_000; index += 1) {
      clock.now = index;
      history.begin("s", `e${index.toString()}`);
      history.finish("s", `e${index.toString()}`, A);
    }

    expect(history.debugSize("s")).toEqual({ runs: 1, pending: 0 });
  });

  test("is unavailable after run truncation", () => {
    const { history, finishAt } = createHistory({ runsPerSession: 2 });
    finishAt(1, A);
    finishAt(2, B);
    finishAt(3, A);

    expect(history.debugSize("s").runs).toBe(2);
    expect(history.summarize("s", 1, 9)).toEqual({ kind: "unavailable" });
    expect(history.summarize("s", 2, 9)).toEqual({
      kind: "window",
      values: [B, A],
    });
  });

  test("is unavailable after pending overflow", () => {
    const { history, clock } = createHistory({ pendingPerSession: 2 });
    clock.now = 5;
    history.begin("s", "a");
    history.begin("s", "b");
    history.begin("s", "c");
    expect(history.debugSize("s").pending).toBeLessThanOrEqual(3);

    clock.now = 6;
    history.finish("s", "a", A);
    history.finish("s", "b", A);
    history.finish("s", "c", A);
    expect(history.debugSize("s").pending).toBe(0);
    expect(history.summarize("s", 4, 9)).toEqual({ kind: "unavailable" });
    expect(history.summarize("s", 5, 9)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("keeps an overflowed generation pending until it finishes", () => {
    const { history, clock } = createHistory({ pendingPerSession: 1 });
    clock.now = 5;
    history.begin("s", "a");
    history.begin("s", "b");

    clock.now = 6;
    history.finish("s", "a", A);
    // "b" was not stored but has not finished yet: a later window must still
    // wait for it.
    expect(history.summarize("s", 7, 9)).toEqual({ kind: "unavailable" });

    clock.now = 8;
    history.finish("s", "b", B);
    expect(history.summarize("s", 7, 9)).toEqual({
      kind: "window",
      values: [B],
    });
  });

  test("advances the eviction watermark", () => {
    const { history, finishAt } = createHistory({ sessions: 1 });
    finishAt(10, A, "s1");
    finishAt(20, A, "s2");
    expect(history.coverageCompleteSinceMs).toBe(20);
    finishAt(30, B, "s1");

    expect(history.coverageCompleteSinceMs).toBe(30);
    expect(history.summarize("s1", 25, 40)).toEqual({ kind: "unavailable" });
    expect(history.summarize("s1", 30, 40)).toEqual({
      kind: "window",
      values: [B],
    });
    expect(history.summarize("s2", 35, 40)).toEqual({ kind: "none" });
  });

  test("keeps an evicted session undecided while its generation is unfinal", () => {
    const { history, clock, finishAt } = createHistory({ sessions: 1 });
    clock.now = 10;
    history.begin("s1", "A");
    finishAt(20, A, "s2");
    clock.now = 30;
    history.begin("s1", "B");
    history.finish("s1", "B", B);

    expect(history.summarize("s1", 30, 40)).toEqual({ kind: "unavailable" });
    clock.now = 35;
    history.finish("s1", "A", A);
    expect(history.summarize("s1", 30, 40)).toEqual({
      kind: "window",
      values: [B, A],
    });
  });

  test("refuses windows while an evicted unfinal generation is forgotten", () => {
    const { history, clock, finishAt } = createHistory({ sessions: 1 });
    clock.now = 10;
    history.begin("s1", "A");
    clock.now = 20;
    history.begin("s2", "X");
    // s3 evicts s2; only one evicted session is remembered, so s1 is
    // forgotten while A is unfinal.
    finishAt(30, A, "s3");

    expect(history.summarize("s3", 30, 40)).toEqual({ kind: "unavailable" });
    history.abandon("s1", "A");
    expect(history.summarize("s3", 30, 40)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("keeps a metadata change as a separate run", () => {
    const { history, finishAt } = createHistory();
    finishAt(1, A);
    finishAt(5, { ...A, otherInstructionCount: 2 });

    expect(history.debugSize("s").runs).toBe(2);
    expect(history.summarize("s", 0, 3)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("keeps sessions separate", () => {
    const { history, finishAt } = createHistory();
    finishAt(10, A, "parent");
    finishAt(11, B, "child");

    expect(history.summarize("parent", 0, 20)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("abandon releases a pending generation without recording it", () => {
    const { history, finishAt } = createHistory();
    finishAt(10, A, "s", "A");
    history.begin("s", "failed");
    history.abandon("s", "failed");

    expect(history.debugSize("s")).toEqual({ runs: 1, pending: 0 });
    expect(history.summarize("s", 5, 30)).toEqual({
      kind: "window",
      values: [A],
    });
  });

  test("drop forgets a session without moving coverage", () => {
    const { history, finishAt } = createHistory();
    finishAt(10, A);
    history.begin("s", "pending");
    history.drop("s");

    expect(history.summarize("s", 0, 20)).toEqual({ kind: "none" });
    expect(history.debugSize("s")).toEqual({ runs: 0, pending: 0 });
    expect(history.coverageCompleteSinceMs).toBe(0);
  });
});
