import { createHash } from "node:crypto";

import { Either, Schema } from "effect";

/**
 * Links OpenCode generations to the Langfuse Prompt Management version whose
 * body equals one whole system part.
 *
 * Versions are read from the public prompt API with the existing credentials
 * and kept as an in-memory index of normalized-body hashes. Tracing never waits
 * for that API: a generation is judged against the snapshot that is usable at
 * that moment, and anything uncertain is left unlinked.
 */

// Marks clients built by this package. Another build (for example the
// upstream release) may own the process-wide client; without this marker the
// plugin uses only the API that build shares with this one.
export const PROMPT_LINKING: unique symbol = Symbol.for(
  "langfuse.opencode.promptLinking.v1",
);

const SNAPSHOT_TTL_MS = 60_000;
const ABSENT_TTL_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 15_000;
const FORCED_REFRESH_INTERVAL_MS = 10_000;
const BACKOFF_INITIAL_MS = 10_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_VERSIONS = 200;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = MAX_BODY_BYTES + 64 * 1024;
const MAX_LIST_PAGES = 20;
const MAX_CONSTRAINT_LENGTH = 256;
const MAX_PROMPT_NAMES = 64;
const LIST_PAGE_SIZE = 100;
const PROMPT_REFERENCE_TAG = "@@@langfusePrompt:";

const normalizePromptText = (text: string) =>
  text.replace(/\r\n/g, "\n").trimEnd();

const hashText = (text: string) =>
  createHash("sha256").update(normalizePromptText(text)).digest("hex");

const PromptLinkingOptionsSchema = Schema.Struct({
  agentPrompt: Schema.optional(Schema.String.pipe(Schema.includes("{agent}"))),
  agents: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.NullOr(Schema.NonEmptyString),
    }),
  ),
});

const decodePromptLinkingOptions = Schema.decodeUnknownEither(
  PromptLinkingOptionsSchema,
  { onExcessProperty: "error" },
);

const parsePromptLinkingOptions = (options: unknown) => {
  const promptLinking: unknown =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "promptLinking")
      : undefined;

  if (promptLinking === undefined) {
    return { _tag: "Disabled" } as const;
  }

  const decoded = decodePromptLinkingOptions(promptLinking);
  if (
    Either.isLeft(decoded) ||
    typeof promptLinking !== "object" ||
    promptLinking === null ||
    Array.isArray(promptLinking)
  ) {
    return { _tag: "Invalid" } as const;
  }

  const agents = Object.entries(decoded.right.agents ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (decoded.right.agentPrompt === undefined && agents.length === 0) {
    return { _tag: "Disabled" } as const;
  }

  return {
    _tag: "Enabled",
    key: JSON.stringify({
      agentPrompt: decoded.right.agentPrompt ?? null,
      agents,
    }),
    agentPrompt: decoded.right.agentPrompt,
    agents: new Map(agents),
  } as const;
};

type PromptLinkingConfig = Extract<
  ReturnType<typeof parsePromptLinkingOptions>,
  { _tag: "Enabled" }
>;

export type PromptLinkResult = {
  name: string;
  status:
    | "matched"
    | "no_match"
    | "ambiguous"
    | "not_registered"
    | "unavailable";
  version?: number;
};

type VersionRecord =
  | {
      readonly kind: "text";
      readonly hash: string;
      readonly model?: string;
      readonly variant?: string;
    }
  | { readonly kind: "excluded" }
  | { readonly kind: "oversize" };

type PromptSnapshot =
  | {
      readonly kind: "present";
      readonly completedAt: number;
      readonly versions: ReadonlyMap<number, VersionRecord>;
      readonly index: ReadonlyMap<
        string,
        readonly { version: number; model?: string; variant?: string }[]
      >;
    }
  | {
      readonly kind: "unavailable";
      readonly completedAt: number;
      readonly versions: ReadonlyMap<number, VersionRecord>;
    }
  | { readonly kind: "absent"; readonly completedAt: number };

type PromptState = {
  snapshot?: PromptSnapshot;
  failedSinceCompletion: boolean;
  building: boolean;
  lastAttemptAt?: number;
  nextRetryAt?: number;
  backoffMs: number;
  reported?: string;
};

class PromptFetchError extends Error {}

const PromptListSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ name: Schema.String, versions: Schema.Array(Schema.Int) }),
  ),
  meta: Schema.Struct({ totalPages: Schema.Number }),
});

const PromptVersionSchema = Schema.Struct({
  version: Schema.Int,
  type: Schema.String,
  prompt: Schema.Unknown,
  config: Schema.optional(Schema.Unknown),
});

const decodeJson = <A, I>(schema: Schema.Schema<A, I>, text: string) => {
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(schema))(text);
  if (Either.isLeft(decoded)) {
    throw new PromptFetchError("unexpected response");
  }
  return decoded.right;
};

// Reads config.model or config.variant. A missing key leaves the version
// unconstrained; a value that is present but not a usable string makes the
// version unlinkable rather than unconstrained.
const configConstraint = (config: unknown, key: string) => {
  const value: unknown =
    typeof config === "object" && config !== null
      ? Reflect.get(config, key)
      : undefined;
  if (value === undefined) {
    return { valid: true, value: undefined } as const;
  }
  return typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_CONSTRAINT_LENGTH
    ? ({ valid: true, value } as const)
    : ({ valid: false } as const);
};

const readLimited = async (response: Response, limit: number) => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
};

export class PromptLinking {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly prompts = new Map<string, PromptState>();
  private readonly requestQueue: (() => void)[] = [];
  private activeRequests = 0;
  private ownerKey: string | undefined;
  private locked = false;
  private warnedInvalidOptions = false;
  private warnedNameLimit = false;
  private config: PromptLinkingConfig | undefined;

  constructor(input: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
    fetch?: typeof fetch;
    now?: () => number;
    warn?: (message: string) => void;
  }) {
    this.baseUrl = input.baseUrl.replace(/\/+$/, "");
    this.authorization = `Basic ${Buffer.from(
      `${input.publicKey}:${input.secretKey}`,
    ).toString("base64")}`;
    this.fetch = input.fetch ?? globalThis.fetch;
    this.now = input.now ?? Date.now;
    this.warn =
      input.warn ??
      ((message) => {
        console.warn(message);
      });
  }

  get enabled() {
    return this.config !== undefined;
  }

  /**
   * Records the options of a plugin instance. The client is shared by every
   * instance in the process and any of them may trace a given generation, so
   * the first options win and a disagreeing instance turns linking off until
   * OpenCode restarts.
   */
  register(options: unknown) {
    const parsed = parsePromptLinkingOptions(options);
    if (parsed._tag === "Invalid" && !this.warnedInvalidOptions) {
      this.warnedInvalidOptions = true;
      this.warn(
        "[Langfuse prompt linking] invalid promptLinking options; prompt linking is disabled",
      );
    }
    const key = parsed._tag === "Enabled" ? parsed.key : "disabled";

    if (this.ownerKey === undefined) {
      this.ownerKey = key;
      if (parsed._tag === "Enabled") {
        this.config = parsed;
        this.prefetch(parsed);
      }
      return;
    }

    if (key !== this.ownerKey && !this.locked) {
      this.locked = true;
      this.config = undefined;
      this.warn(
        "[Langfuse prompt linking] plugin instances disagree on promptLinking options; prompt linking is disabled until OpenCode restarts",
      );
    }
  }

  hashSystem(snapshot: unknown) {
    if (!this.enabled) {
      return undefined;
    }

    const system: unknown =
      typeof snapshot === "object" && snapshot !== null
        ? Reflect.get(snapshot, "system")
        : undefined;
    if (!Array.isArray(system)) {
      return undefined;
    }

    return system.flatMap((part: unknown) => {
      const text: unknown =
        typeof part === "object" && part !== null
          ? Reflect.get(part, "text")
          : undefined;
      return typeof text === "string" ? [hashText(text)] : [];
    });
  }

  /**
   * Judges a generation without waiting. It may start a background snapshot
   * build; the caller can judge again later (for example when the step ends).
   */
  judge(input: {
    hashes: readonly string[];
    agent?: string;
    model?: { id: string; providerID: string; variant?: string };
  }): PromptLinkResult | undefined {
    try {
      const name = this.promptName(input.agent);
      if (name === undefined) {
        return undefined;
      }

      const state = this.state(name);
      if (state === undefined) {
        return { name, status: "unavailable" };
      }
      this.refresh(name, state, false);
      const snapshot = this.usableSnapshot(state);
      if (snapshot === undefined) {
        return { name, status: "unavailable" };
      }
      if (snapshot.kind === "absent") {
        return { name, status: "not_registered" };
      }
      if (snapshot.kind === "unavailable") {
        return { name, status: "unavailable" };
      }

      const modelRef =
        input.model === undefined
          ? undefined
          : `${input.model.providerID}/${input.model.id}`;
      const groups = new Map<string, number>();
      for (const hash of new Set(input.hashes)) {
        for (const entry of snapshot.index.get(hash) ?? []) {
          if (
            (entry.model === undefined || entry.model === modelRef) &&
            (entry.variant === undefined ||
              entry.variant === input.model?.variant)
          ) {
            const group = JSON.stringify([
              hash,
              entry.model ?? null,
              entry.variant ?? null,
            ]);
            groups.set(
              group,
              Math.max(groups.get(group) ?? entry.version, entry.version),
            );
          }
        }
      }

      if (groups.size === 0) {
        this.refresh(name, state, true);
        return { name, status: "no_match" };
      }
      if (groups.size > 1) {
        return { name, status: "ambiguous" };
      }
      return {
        name,
        status: "matched",
        version: Array.from(groups.values())[0],
      };
    } catch {
      return undefined;
    }
  }

  private promptName(agent: string | undefined) {
    if (this.config === undefined || agent === undefined || agent === "") {
      return undefined;
    }
    if (this.config.agents.has(agent)) {
      return this.config.agents.get(agent) ?? undefined;
    }
    return this.config.agentPrompt?.replaceAll("{agent}", agent);
  }

  private prefetch(config: PromptLinkingConfig) {
    const names = new Set(
      Array.from(config.agents.values()).filter(
        (name): name is string => name !== null,
      ),
    );
    if (names.size === 0) {
      return;
    }

    setTimeout(() => {
      for (const name of names) {
        const state = this.enabled ? this.state(name) : undefined;
        if (state !== undefined) {
          this.refresh(name, state, false);
        }
      }
    }, 0).unref();
  }

  // Names are never evicted; past the limit new names are not tracked at all,
  // so the memory held for snapshots stays bounded.
  private state(name: string) {
    const existing = this.prompts.get(name);
    if (existing) {
      return existing;
    }
    if (this.prompts.size >= MAX_PROMPT_NAMES) {
      if (!this.warnedNameLimit) {
        this.warnedNameLimit = true;
        this.warn(
          `[Langfuse prompt linking] more than ${MAX_PROMPT_NAMES.toString()} prompt names; further names are not linked`,
        );
      }
      return undefined;
    }
    const created: PromptState = {
      failedSinceCompletion: false,
      building: false,
      backoffMs: BACKOFF_INITIAL_MS,
    };
    this.prompts.set(name, created);
    return created;
  }

  private usableSnapshot(state: PromptState) {
    const snapshot = state.snapshot;
    if (snapshot === undefined || state.failedSinceCompletion) {
      return undefined;
    }
    const ttl = snapshot.kind === "absent" ? ABSENT_TTL_MS : SNAPSHOT_TTL_MS;
    return this.now() - snapshot.completedAt <= ttl ? snapshot : undefined;
  }

  private refresh(name: string, state: PromptState, forced: boolean) {
    if (state.building) {
      return;
    }
    const now = this.now();
    if (state.nextRetryAt !== undefined && now < state.nextRetryAt) {
      return;
    }

    const snapshot = state.snapshot;
    const ttl = snapshot?.kind === "absent" ? ABSENT_TTL_MS : SNAPSHOT_TTL_MS;
    const due =
      snapshot === undefined ||
      state.failedSinceCompletion ||
      now - snapshot.completedAt > ttl - REFRESH_AHEAD_MS;
    const forcedDue =
      forced &&
      (state.lastAttemptAt === undefined ||
        now - state.lastAttemptAt >= FORCED_REFRESH_INTERVAL_MS);

    if (due || forcedDue) {
      void this.build(name, state);
    }
  }

  private async build(name: string, state: PromptState) {
    state.building = true;
    state.lastAttemptAt = this.now();
    const abort = new AbortController();

    try {
      const snapshot = await this.createSnapshot(name, state, abort.signal);
      state.snapshot = { ...snapshot, completedAt: this.now() };
      state.failedSinceCompletion = false;
      state.nextRetryAt = undefined;
      state.backoffMs = BACKOFF_INITIAL_MS;
      this.report(
        name,
        state,
        snapshot.kind === "unavailable"
          ? "limit exceeded or no usable version"
          : undefined,
      );
    } catch (error) {
      abort.abort();
      state.failedSinceCompletion = true;
      state.nextRetryAt = this.now() + state.backoffMs;
      state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
      this.report(
        name,
        state,
        error instanceof PromptFetchError ? error.message : "transport failure",
      );
    } finally {
      state.building = false;
    }
  }

  private report(
    name: string,
    state: PromptState,
    problem: string | undefined,
  ) {
    if (problem !== undefined && problem !== state.reported) {
      this.warn(`[Langfuse prompt linking] ${name}: ${problem}`);
    }
    state.reported = problem;
  }

  private async createSnapshot(
    name: string,
    state: PromptState,
    signal: AbortSignal,
  ) {
    const versions = await this.listVersions(name, signal);
    if (versions === undefined || versions.length === 0) {
      return { kind: "absent" } as const;
    }
    if (versions.length > MAX_VERSIONS) {
      return { kind: "unavailable", versions: new Map() } as const;
    }

    const previous =
      state.snapshot !== undefined && state.snapshot.kind !== "absent"
        ? state.snapshot.versions
        : new Map<number, VersionRecord>();
    const records = new Map<number, VersionRecord>();
    await Promise.all(
      versions.map(async (version) => {
        records.set(
          version,
          previous.get(version) ??
            (await this.fetchVersion(name, version, signal)),
        );
      }),
    );

    const ordered = new Map(
      versions.map((version) => [version, records.get(version)] as const),
    );
    const texts = Array.from(ordered).flatMap(([version, record]) =>
      record?.kind === "text" ? [{ version, record }] : [],
    );
    if (
      texts.length === 0 ||
      Array.from(ordered.values()).some((record) => record?.kind === "oversize")
    ) {
      return { kind: "unavailable", versions: records } as const;
    }

    const index = new Map<
      string,
      { version: number; model?: string; variant?: string }[]
    >();
    for (const { version, record } of texts) {
      const entries = index.get(record.hash) ?? [];
      entries.push({ version, model: record.model, variant: record.variant });
      index.set(record.hash, entries);
    }

    return { kind: "present", versions: records, index } as const;
  }

  private async listVersions(name: string, signal: AbortSignal) {
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams({
        name,
        page: page.toString(),
        limit: LIST_PAGE_SIZE.toString(),
      });
      const response = await this.request(
        `${this.baseUrl}/api/public/v2/prompts?${query.toString()}`,
        signal,
      );
      if (response === undefined) {
        return undefined;
      }
      if (response === null) {
        throw new PromptFetchError("unexpected response");
      }

      const list = decodeJson(PromptListSchema, response);
      const item = list.data.find((candidate) => candidate.name === name);
      if (item) {
        return item.versions;
      }
      if (page >= list.meta.totalPages) {
        return undefined;
      }
    }

    throw new PromptFetchError("unexpected response");
  }

  private async fetchVersion(
    name: string,
    version: number,
    signal: AbortSignal,
  ): Promise<VersionRecord> {
    const query = new URLSearchParams({
      version: version.toString(),
      resolve: "false",
    });
    const response = await this.request(
      `${this.baseUrl}/api/public/v2/prompts/${encodeURIComponent(name)}?${query.toString()}`,
      signal,
      true,
    );
    if (response === undefined) {
      throw new PromptFetchError("HTTP 404");
    }
    if (response === null) {
      return { kind: "oversize" };
    }

    const prompt = decodeJson(PromptVersionSchema, response);
    if (prompt.version !== version) {
      throw new PromptFetchError("unexpected response");
    }
    if (prompt.type !== "text" || typeof prompt.prompt !== "string") {
      return { kind: "excluded" };
    }
    if (Buffer.byteLength(prompt.prompt, "utf8") > MAX_BODY_BYTES) {
      return { kind: "oversize" };
    }
    if (prompt.prompt.includes(PROMPT_REFERENCE_TAG)) {
      return { kind: "excluded" };
    }

    const model = configConstraint(prompt.config, "model");
    const variant = configConstraint(prompt.config, "variant");
    if (!model.valid || !variant.valid) {
      return { kind: "excluded" };
    }

    return {
      kind: "text",
      hash: hashText(prompt.prompt),
      model: model.value,
      variant: variant.value,
    };
  }

  /**
   * Returns the response text, undefined for 404, or null when a version body
   * is larger than allowed. Credentials go only to the configured base URL:
   * redirects are refused.
   */
  private async request(
    url: string,
    signal: AbortSignal,
    allowOversize = false,
  ) {
    await this.acquireRequestSlot();
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS);
    timer.unref();

    try {
      if (signal.aborted) {
        throw new PromptFetchError("transport failure");
      }

      let response: Response;
      try {
        response = await this.fetch(url, {
          headers: {
            Authorization: this.authorization,
            Accept: "application/json",
          },
          redirect: "error",
          signal: abort.signal,
        });
      } catch {
        throw new PromptFetchError("transport failure");
      }

      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PromptFetchError(`HTTP ${response.status.toString()}`);
      }

      let text: string | undefined;
      try {
        text = await readLimited(response, MAX_RESPONSE_BYTES);
      } catch {
        throw new PromptFetchError("transport failure");
      }
      if (text === undefined) {
        if (allowOversize) {
          return null;
        }
        throw new PromptFetchError("unexpected response");
      }
      return text;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      this.releaseRequestSlot();
    }
  }

  private acquireRequestSlot() {
    if (this.activeRequests < MAX_CONCURRENT_REQUESTS) {
      this.activeRequests += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.requestQueue.push(() => {
        this.activeRequests += 1;
        resolve();
      });
    });
  }

  private releaseRequestSlot() {
    this.activeRequests -= 1;
    this.requestQueue.shift()?.();
  }
}
