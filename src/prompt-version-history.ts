import type { PromptVersionValue } from "./prompt-versions.js";

/**
 * Per-session history of final prompt version values, used to stamp spans
 * that cover a time window (tool and event spans, evaluation tasks).
 *
 * Each generation is recorded once, at the moment its value became final.
 * Equal consecutive values fold into one run, so memory per session stays
 * bounded by the number of value changes, never by the number of
 * generations. Whenever the history can no longer prove what happened in a
 * window, the window is reported as unavailable instead of guessed.
 */

type Run = {
  readonly firstMs: number;
  lastMs: number;
  value: PromptVersionValue;
  readonly key: string;
};

type SessionRecord = {
  readonly runs: Run[];
  readonly pending: Set<string>;
  // Generations begun after the pending set was full. They are not stored,
  // but they still keep the session undecided until they finish.
  untracked: number;
  coverageFromMs: number;
};

export type HistorySummary =
  | { readonly kind: "window"; readonly values: readonly PromptVersionValue[] }
  | { readonly kind: "latest"; readonly value: PromptVersionValue }
  | { readonly kind: "unavailable" }
  | { readonly kind: "none" };

// Every field that reaches the attributes is part of a run's identity, so
// folding equal values never hides a change.
const runKey = (value: PromptVersionValue) =>
  JSON.stringify([
    value.release ?? null,
    value.version ?? null,
    value.agentsMdStatus,
    value.agentsMdVersion ?? null,
    value.agentsMdChanged,
    value.agentsMdSha12 ?? null,
    value.agentPromptStatus ?? null,
    value.otherInstructionCount,
  ]);

// The unfinal generations of an evicted session. They still keep that
// session undecided when it is used again.
type Unfinal = { readonly pending: Set<string>; untracked: number };

export class SessionVersionHistory {
  private readonly now: () => number;
  private readonly runsPerSession: number;
  private readonly pendingPerSession: number;
  private readonly capacity: number;
  private readonly sessions = new Map<string, SessionRecord>();
  // At most `capacity` evicted sessions with unfinal generations are
  // remembered; older ones are only counted in `forgottenUnfinal`, which
  // refuses every window until that many unknown generations ended.
  private readonly evictedUnfinal = new Map<string, Unfinal>();
  private forgottenUnfinal = 0;
  private completeSinceMs: number;

  constructor(input: {
    startedAtMs: number;
    now: () => number;
    runsPerSession?: number;
    pendingPerSession?: number;
    sessions?: number;
  }) {
    this.now = input.now;
    this.completeSinceMs = input.startedAtMs;
    this.runsPerSession = input.runsPerSession ?? 256;
    this.pendingPerSession = input.pendingPerSession ?? 64;
    this.capacity = input.sessions ?? 2000;
  }

  /** Windows that start before this time cannot be decided. */
  get coverageCompleteSinceMs() {
    return this.completeSinceMs;
  }

  // Least recently used sessions are evicted; any window that starts before
  // an eviction is unavailable from then on. Only the unfinal generations of
  // an evicted session are kept (bounded), so it stays undecided until they
  // end.
  private use(sessionID: string) {
    const existing = this.sessions.get(sessionID);
    if (existing !== undefined) {
      this.sessions.delete(sessionID);
      this.sessions.set(sessionID, existing);
      return existing;
    }

    while (this.sessions.size >= this.capacity) {
      const oldest = this.sessions.keys().next();
      if (oldest.done === true) {
        break;
      }
      const evicted = this.sessions.get(oldest.value);
      this.sessions.delete(oldest.value);
      this.completeSinceMs = Math.max(this.completeSinceMs, this.now());
      if (
        evicted !== undefined &&
        (evicted.pending.size > 0 || evicted.untracked > 0)
      ) {
        this.rememberUnfinal(oldest.value, evicted);
      }
    }
    const unfinal = this.evictedUnfinal.get(sessionID);
    this.evictedUnfinal.delete(sessionID);
    const created: SessionRecord = {
      runs: [],
      pending: unfinal?.pending ?? new Set(),
      untracked: unfinal?.untracked ?? 0,
      coverageFromMs: -Infinity,
    };
    this.sessions.set(sessionID, created);
    return created;
  }

  private rememberUnfinal(sessionID: string, session: SessionRecord) {
    this.evictedUnfinal.set(sessionID, {
      pending: session.pending,
      untracked: session.untracked,
    });
    while (this.evictedUnfinal.size > this.capacity) {
      const oldest = this.evictedUnfinal.entries().next();
      if (oldest.done === true) {
        break;
      }
      const [oldestID, forgotten] = oldest.value;
      this.evictedUnfinal.delete(oldestID);
      this.forgottenUnfinal += forgotten.pending.size + forgotten.untracked;
    }
  }

  begin(sessionID: string, entryId: string) {
    const session = this.use(sessionID);
    if (session.pending.has(entryId)) {
      return;
    }
    if (session.pending.size >= this.pendingPerSession) {
      session.untracked += 1;
      session.coverageFromMs = Math.max(session.coverageFromMs, this.now());
      return;
    }
    session.pending.add(entryId);
  }

  // Ends the unfinal state of one generation, wherever it is kept.
  private release(sessionID: string, entryId: string) {
    const session = this.sessions.get(sessionID);
    const unfinal = session ?? this.evictedUnfinal.get(sessionID);
    if (unfinal !== undefined) {
      if (!unfinal.pending.delete(entryId) && unfinal.untracked > 0) {
        unfinal.untracked -= 1;
      }
      if (
        session === undefined &&
        unfinal.pending.size === 0 &&
        unfinal.untracked === 0
      ) {
        this.evictedUnfinal.delete(sessionID);
      }
      return;
    }
    if (this.forgottenUnfinal > 0) {
      this.forgottenUnfinal -= 1;
    }
  }

  // A generation whose value could not be computed (internal error): it no
  // longer keeps the session undecided, and nothing is recorded for it.
  abandon(sessionID: string, entryId: string) {
    this.release(sessionID, entryId);
  }

  finish(sessionID: string, entryId: string, value: PromptVersionValue) {
    this.release(sessionID, entryId);
    const session = this.use(sessionID);

    const time = this.now();
    const key = runKey(value);
    const last = session.runs.at(-1);
    if (last?.key === key) {
      last.lastMs = Math.max(last.lastMs, time);
      last.value = value;
      return;
    }

    session.runs.push({ firstMs: time, lastMs: time, value, key });
    if (session.runs.length > this.runsPerSession) {
      session.runs.shift();
      const oldest = session.runs.at(0);
      if (oldest !== undefined) {
        session.coverageFromMs = Math.max(
          session.coverageFromMs,
          oldest.firstMs,
        );
      }
    }
  }

  drop(sessionID: string) {
    this.sessions.delete(sessionID);
    this.evictedUnfinal.delete(sessionID);
  }

  clear() {
    this.sessions.clear();
    this.evictedUnfinal.clear();
    this.forgottenUnfinal = 0;
  }

  /**
   * The values determined in `[fromMs, toMs]`; if there are none, the last
   * value determined before `fromMs`.
   */
  summarize(sessionID: string, fromMs: number, toMs: number): HistorySummary {
    if (fromMs < this.completeSinceMs) {
      return { kind: "unavailable" };
    }
    const session = this.sessions.get(sessionID);
    if (session === undefined) {
      return { kind: "none" };
    }
    if (
      fromMs < session.coverageFromMs ||
      session.pending.size > 0 ||
      session.untracked > 0 ||
      this.forgottenUnfinal > 0
    ) {
      return { kind: "unavailable" };
    }

    // Runs are ordered by determination time and never overlap, so a run
    // that intersects the window holds a determination inside it, except a
    // single run that encloses the window, whose value is also the latest
    // one before it.
    const inWindow = session.runs.filter(
      (run) => run.lastMs >= fromMs && run.firstMs <= toMs,
    );
    if (inWindow.length > 0) {
      return { kind: "window", values: inWindow.map((run) => run.value) };
    }
    const before = session.runs.findLast((run) => run.lastMs < fromMs);
    return before === undefined
      ? { kind: "none" }
      : { kind: "latest", value: before.value };
  }

  debugSize(sessionID: string) {
    const session = this.sessions.get(sessionID);
    return {
      runs: session?.runs.length ?? 0,
      pending: (session?.pending.size ?? 0) + (session?.untracked ?? 0),
    };
  }
}
