import { createHash } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import { PromptLinking } from "../../src/prompt-link.js";

const PUBLIC_KEY = "pk-lf-unit";
const SECRET_KEY = "sk-lf-unit-secret";
const BASE_URL = "https://langfuse.test";
const AUTHORIZATION = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

const BODY_A = "You are the reviewer.\nCheck every change.\n";
const BODY_B = "You are the reviewer.\nCheck only tests.\n";
const model = { id: "model-1", providerID: "provider-1" };
const MODEL_REF = "provider-1/model-1";

type FakeVersion = {
  type?: string;
  prompt: unknown;
  config?: unknown;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const createLangfuse = () => {
  const prompts = new Map<string, Map<number, FakeVersion>>();
  const calls: { url: URL; init?: RequestInit }[] = [];
  let intercept:
    | ((url: URL, init?: RequestInit) => Promise<Response> | undefined)
    | undefined;

  const route = (url: URL) => {
    const prefix = "/api/public/v2/prompts";
    if (url.pathname === prefix) {
      const name = url.searchParams.get("name") ?? "";
      const versions = prompts.get(name);
      return json(200, {
        data:
          versions === undefined
            ? []
            : [{ name, versions: Array.from(versions.keys()) }],
        meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
      });
    }

    const name = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    const version = Number(url.searchParams.get("version"));
    const stored = prompts.get(name)?.get(version);
    if (stored === undefined) {
      return json(404, { message: "Prompt not found" });
    }
    return json(200, {
      name,
      version,
      type: stored.type ?? "text",
      prompt: stored.prompt,
      config: stored.config ?? {},
      labels: [],
      tags: [],
    });
  };

  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return intercept?.(url, init) ?? Promise.resolve(route(url));
  };

  return {
    fetch,
    calls,
    add: (name: string, version: number, value: FakeVersion) => {
      const versions = prompts.get(name) ?? new Map<number, FakeVersion>();
      versions.set(version, value);
      prompts.set(name, versions);
    },
    intercept: (
      handler:
        | ((url: URL, init?: RequestInit) => Promise<Response> | undefined)
        | undefined,
    ) => {
      intercept = handler;
    },
    listCalls: () =>
      calls.filter((call) => call.url.pathname === "/api/public/v2/prompts"),
    bodyCalls: () =>
      calls.filter((call) => call.url.pathname !== "/api/public/v2/prompts"),
  };
};

const settle = async () => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

const createLinking = (
  options: unknown = { agentPrompt: "agents/{agent}" },
) => {
  const langfuse = createLangfuse();
  const clock = { now: 1_000_000 };
  const warnings: string[] = [];
  const linking = new PromptLinking({
    baseUrl: BASE_URL,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    fetch: langfuse.fetch,
    now: () => clock.now,
    warn: (message) => {
      warnings.push(message);
    },
  });
  linking.register({ promptLinking: options });

  const judge = (
    system: readonly string[] = [BODY_A.trimEnd()],
    input: {
      agent?: string;
      model?: { id: string; providerID: string; variant?: string };
    } = { agent: "reviewer", model },
  ) =>
    linking.judge({
      hashes:
        linking.hashSystem({
          system: system.map((text) => ({ type: "text", text })),
        }) ?? [],
      ...input,
    });

  // The first judgement starts the snapshot; the next one sees it.
  const warm = async (...args: Parameters<typeof judge>) => {
    judge(...args);
    await settle();
    return judge(...args);
  };

  return { langfuse, clock, warnings, linking, judge, warm };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("prompt text normalization", () => {
  test("converts CRLF and trims only trailing whitespace on both sides", async () => {
    const { langfuse, warm, judge } = createLinking();
    langfuse.add("agents/reviewer", 1, {
      prompt: "  Line one\r\nLine two \r\n\n\t",
    });

    expect(await warm(["  Line one\nLine two\n"])).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 1,
    });
    expect(judge(["Line one\nLine two"])).toEqual({
      name: "agents/reviewer",
      status: "no_match",
    });
  });
});

describe("promptLinking options", () => {
  const register = (options: unknown) => {
    const warnings: string[] = [];
    const linking = new PromptLinking({
      baseUrl: BASE_URL,
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      fetch: () => Promise.reject(new Error("unexpected fetch")),
      warn: (message) => {
        warnings.push(message);
      },
    });
    linking.register(options);
    return { linking, warnings };
  };

  test("is disabled without a warning when absent or when neither agentPrompt nor agents names a prompt", () => {
    for (const options of [
      undefined,
      {},
      { other: true },
      { promptLinking: {} },
      { promptLinking: { agents: {} } },
    ]) {
      const { linking, warnings } = register(options);
      expect(linking.enabled).toBe(false);
      expect(warnings).toEqual([]);
    }
  });

  test("is disabled with one warning for malformed shapes and keys outside the contract", () => {
    for (const promptLinking of [
      null,
      "agents/{agent}",
      { agentPrompt: "agents/reviewer" },
      { agentPrompt: 1 },
      { agents: { reviewer: 1 } },
      { agents: { reviewer: "" } },
      { agents: [] },
      { agentPrompt: "agents/{agent}", secondary: { build: "policy/AGENTS" } },
      { agentPrompt: "agents/{agent}", instructionPath: "AGENTS.md" },
    ]) {
      const { linking, warnings } = register({ promptLinking });
      expect(linking.enabled).toBe(false);
      expect(warnings).toEqual([
        "[Langfuse prompt linking] invalid promptLinking options; prompt linking is disabled",
      ]);
    }
  });

  test("treats options that differ only in key order as the same options", () => {
    const { linking, warnings } = register({
      promptLinking: {
        agents: { b: "prompt-b", a: null },
        agentPrompt: "agents/{agent}",
      },
    });
    linking.register({
      promptLinking: {
        agentPrompt: "agents/{agent}",
        agents: { a: null, b: "prompt-b" },
      },
    });

    expect(linking.enabled).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("process-wide options owner", () => {
  test("keeps the first options and disables linking for the process when another instance disagrees", () => {
    const { linking, warnings } = createLinking();
    linking.register({ promptLinking: { agentPrompt: "agents/{agent}" } });
    expect(linking.enabled).toBe(true);

    linking.register({});
    linking.register({ promptLinking: { agentPrompt: "other/{agent}" } });
    linking.register({ promptLinking: { agentPrompt: "agents/{agent}" } });

    expect(linking.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  test("does not enable linking when the first owner was disabled", () => {
    const { linking, langfuse } = createLinking({});
    linking.register({ promptLinking: { agentPrompt: "agents/{agent}" } });

    expect(linking.enabled).toBe(false);
    expect(linking.hashSystem({ system: [{ type: "text", text: "x" }] })).toBe(
      undefined,
    );
    expect(linking.judge({ hashes: ["x"], agent: "reviewer", model })).toBe(
      undefined,
    );
    expect(langfuse.calls).toEqual([]);
  });

  test("warns once per process and stays off for invalid options", async () => {
    const { linking, langfuse, warnings, judge } = createLinking({
      agentPrompt: "agents/reviewer",
    });
    linking.register({ promptLinking: { agentPrompt: "agents/reviewer" } });
    linking.register({ promptLinking: { instructionPath: "AGENTS.md" } });

    expect(linking.enabled).toBe(false);
    expect(judge()).toBe(undefined);
    await settle();
    expect(langfuse.calls).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("prompt name resolution", () => {
  test("prefers explicit agents, excludes null agents and agentless generations", async () => {
    const { judge, langfuse, warm } = createLinking({
      agentPrompt: "agents/{agent}",
      agents: { reviewer: "custom/reviewer", build: null },
    });
    langfuse.add("custom/reviewer", 1, { prompt: BODY_A });

    expect(await warm()).toEqual({
      name: "custom/reviewer",
      status: "matched",
      version: 1,
    });
    expect(judge(undefined, { agent: "build", model })).toBe(undefined);
    expect(judge(undefined, { model })).toBe(undefined);
  });

  test("prefetches explicit agent prompts after registration, but not pattern names", async () => {
    const { langfuse } = createLinking({
      agentPrompt: "agents/{agent}",
      agents: { reviewer: "custom/reviewer", build: null },
    });

    expect(langfuse.calls).toEqual([]);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await settle();
    expect(langfuse.listCalls().map((call) => call.url.search)).toEqual([
      "?name=custom%2Freviewer&page=1&limit=100",
    ]);
  });
});

describe("whole system part matching", () => {
  test("links a system part at any position that equals the registered body", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_B });
    langfuse.add("agents/reviewer", 2, {
      prompt: BODY_A.replace(/\n/g, "\r\n"),
    });

    expect(
      await warm(["Instructions from: /AGENTS.md\n# Policy", BODY_A]),
    ).toEqual({ name: "agents/reviewer", status: "matched", version: 2 });
  });

  test("does not link a part that only extends or contains the registered body", async () => {
    const { langfuse, warm, judge } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });

    expect(await warm([`${BODY_A}Also check docs.`])).toEqual({
      name: "agents/reviewer",
      status: "no_match",
    });
    expect(judge([`Instructions from: /AGENTS.md\n${BODY_A}`])).toEqual({
      name: "agents/reviewer",
      status: "no_match",
    });
  });

  test("links the newest version among versions identical in body, model and variant", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    langfuse.add("agents/reviewer", 2, { prompt: BODY_B });
    langfuse.add("agents/reviewer", 3, { prompt: BODY_A });

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 3,
    });
  });

  test("selects the single body/model/variant group that fits the generation", async () => {
    const { langfuse, warm, judge } = createLinking();
    langfuse.add("agents/reviewer", 1, {
      prompt: BODY_A,
      config: { model: MODEL_REF, variant: "high" },
    });
    langfuse.add("agents/reviewer", 2, {
      prompt: BODY_A,
      config: { model: "provider-1/model-2" },
    });

    expect(
      await warm(undefined, {
        agent: "reviewer",
        model: { ...model, variant: "high" },
      }),
    ).toEqual({ name: "agents/reviewer", status: "matched", version: 1 });
    expect(judge(undefined, { agent: "reviewer", model })).toEqual({
      name: "agents/reviewer",
      status: "no_match",
    });
  });

  test("reports ambiguity when versions with and without a model both fit one part", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    langfuse.add("agents/reviewer", 2, {
      prompt: BODY_A,
      config: { model: MODEL_REF },
    });

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "ambiguous",
    });
  });

  test("reports ambiguity when different parts match different versions", async () => {
    const { langfuse, warm, judge } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    langfuse.add("agents/reviewer", 2, { prompt: BODY_B });

    expect(await warm([BODY_B, "unrelated"])).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 2,
    });
    expect(judge([BODY_B, BODY_A])).toEqual({
      name: "agents/reviewer",
      status: "ambiguous",
    });
  });

  test("ignores chat versions and versions with prompt references", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 1, {
      type: "chat",
      prompt: [{ role: "system", content: BODY_A }],
    });
    langfuse.add("agents/reviewer", 2, {
      prompt: `${BODY_A.trimEnd()}\n@@@langfusePrompt:name=base|label=production@@@`,
    });
    langfuse.add("agents/reviewer", 3, { prompt: BODY_B });

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "no_match",
    });
    expect(
      langfuse
        .bodyCalls()
        .every((call) => call.url.searchParams.get("resolve") === "false"),
    ).toBe(true);
  });

  test("is unavailable when every version is excluded", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 1, { type: "chat", prompt: [] });
    langfuse.add("agents/reviewer", 2, {
      prompt: "@@@langfusePrompt:name=base|label=production@@@",
    });

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "unavailable",
    });
  });
});

describe("version config constraints", () => {
  const BODY_VALID = "A version with a valid constraint.\n";

  test("never links a version whose model or variant is present but invalid", async () => {
    // Present but invalid: not a string, empty, or longer than 256 characters.
    // Absent (missing or undefined) leaves the version unconstrained.
    for (const config of [
      { model: { id: "model-1" } },
      { model: 1 },
      { model: "" },
      { model: null },
      { model: `${MODEL_REF}${"x".repeat(257 - MODEL_REF.length)}` },
      { variant: ["high"] },
      { variant: 0 },
      { variant: "" },
      { variant: "v".repeat(257) },
    ]) {
      const { langfuse, warm } = createLinking();
      langfuse.add("agents/reviewer", 1, {
        prompt: BODY_VALID,
        config: { model: MODEL_REF },
      });
      langfuse.add("agents/reviewer", 2, { prompt: BODY_A, config });

      expect(await warm()).toEqual({
        name: "agents/reviewer",
        status: "no_match",
      });
    }
  });

  test("keeps a missing constraint, and an exact 256-character one, usable", async () => {
    const variant = "v".repeat(256);
    const { langfuse, warm, judge } = createLinking();
    langfuse.add("agents/reviewer", 1, {
      prompt: BODY_A,
      config: { model: MODEL_REF, variant },
    });
    langfuse.add("agents/reviewer", 2, {
      prompt: BODY_B,
      config: { other: 1 },
    });

    expect(
      await warm(undefined, {
        agent: "reviewer",
        model: { ...model, variant },
      }),
    ).toEqual({ name: "agents/reviewer", status: "matched", version: 1 });
    expect(judge([BODY_B])).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 2,
    });
  });
});

describe("tracked prompt names", () => {
  test("tracks at most 64 names and reports later names as unavailable without fetching", async () => {
    const { langfuse, judge, warnings } = createLinking();
    for (let index = 0; index < 64; index += 1) {
      judge(undefined, { agent: `agent-${index.toString()}`, model });
    }
    await settle();
    const listed = langfuse.listCalls().length;
    expect(listed).toBe(64);

    expect(judge(undefined, { agent: "agent-64", model })).toEqual({
      name: "agents/agent-64",
      status: "unavailable",
    });
    expect(judge(undefined, { agent: "agent-65", model })).toEqual({
      name: "agents/agent-65",
      status: "unavailable",
    });
    await settle();

    expect(langfuse.listCalls()).toHaveLength(listed);
    expect(
      warnings.filter((warning) => warning.includes("64 prompt names")),
    ).toEqual([
      "[Langfuse prompt linking] more than 64 prompt names; further names are not linked",
    ]);
    expect(judge(undefined, { agent: "agent-0", model })).toEqual({
      name: "agents/agent-0",
      status: "not_registered",
    });
  });
});

describe("prompt fetching", () => {
  test("pages the list, uses only the exact name and fetches raw bodies with basic auth and no redirects", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 2, { prompt: BODY_A });
    langfuse.intercept((url) => {
      if (url.pathname !== "/api/public/v2/prompts") {
        return undefined;
      }
      return Promise.resolve(
        url.searchParams.get("page") === "1"
          ? json(200, {
              data: [{ name: "agents/reviewer-old", versions: [7] }],
              meta: { page: 1, limit: 100, totalItems: 2, totalPages: 2 },
            })
          : json(200, {
              data: [{ name: "agents/reviewer", versions: [2] }],
              meta: { page: 2, limit: 100, totalItems: 2, totalPages: 2 },
            }),
      );
    });

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 2,
    });
    expect(
      langfuse.calls.map((call) => `${call.url.pathname}${call.url.search}`),
    ).toEqual([
      "/api/public/v2/prompts?name=agents%2Freviewer&page=1&limit=100",
      "/api/public/v2/prompts?name=agents%2Freviewer&page=2&limit=100",
      "/api/public/v2/prompts/agents%2Freviewer?version=2&resolve=false",
    ]);
    for (const call of langfuse.calls) {
      expect(call.init?.redirect).toBe("error");
      expect(new Headers(call.init?.headers).get("authorization")).toBe(
        AUTHORIZATION,
      );
    }
  });

  test("treats a missing prompt as not registered for ten minutes", async () => {
    const { langfuse, warm, judge, clock } = createLinking();

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "not_registered",
    });
    clock.now += 9 * 60_000;
    judge();
    await settle();
    expect(langfuse.listCalls()).toHaveLength(1);
    expect(judge()).toEqual({
      name: "agents/reviewer",
      status: "not_registered",
    });

    clock.now += 60_001;
    expect(judge()).toEqual({ name: "agents/reviewer", status: "unavailable" });
  });

  test("treats a 404 list response as not registered", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.intercept(() => Promise.resolve(json(404, {})));

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "not_registered",
    });
  });

  test("aborts a request after three seconds and reports a transport failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { langfuse, judge, warnings } = createLinking();
    langfuse.intercept(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    judge();
    await settle();
    vi.advanceTimersByTime(2_999);
    await settle();
    expect(warnings).toEqual([]);
    vi.advanceTimersByTime(1);
    await settle();

    expect(judge()).toEqual({ name: "agents/reviewer", status: "unavailable" });
    expect(warnings).toEqual([
      "[Langfuse prompt linking] agents/reviewer: transport failure",
    ]);
  });

  test("does not fetch bodies for a prompt with more than 200 versions", async () => {
    const { langfuse, warm } = createLinking();
    for (let version = 1; version <= 201; version += 1) {
      langfuse.add("agents/reviewer", version, { prompt: BODY_A });
    }

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "unavailable",
    });
    expect(langfuse.bodyCalls()).toEqual([]);
  });

  test("is unavailable when a version body exceeds 1 MiB", async () => {
    const { langfuse, warm } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    langfuse.add("agents/reviewer", 2, { prompt: "x".repeat(1024 * 1024 + 1) });

    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "unavailable",
    });
  });

  test("warns once per state change with the HTTP status only", async () => {
    const { langfuse, judge, warm, warnings, clock } = createLinking();
    langfuse.intercept(() =>
      Promise.resolve(json(401, { secret: "response-body-detail" })),
    );

    await warm();
    clock.now += 10_000;
    await warm();
    langfuse.intercept(undefined);
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    clock.now += 20_000;
    await warm();
    langfuse.intercept(() => Promise.reject(new Error(SECRET_KEY)));
    clock.now += 46_000;
    judge();
    await settle();

    expect(warnings).toEqual([
      "[Langfuse prompt linking] agents/reviewer: HTTP 401",
      "[Langfuse prompt linking] agents/reviewer: transport failure",
    ]);
    for (const warning of warnings) {
      expect(warning).not.toContain(PUBLIC_KEY);
      expect(warning).not.toContain(SECRET_KEY);
      expect(warning).not.toContain(AUTHORIZATION.slice(6));
      expect(warning).not.toContain("response-body-detail");
    }
  });

  test("runs at most two requests at once and one snapshot build per name", async () => {
    const { langfuse, judge } = createLinking();
    for (let version = 1; version <= 5; version += 1) {
      langfuse.add("agents/reviewer", version, {
        prompt: `${BODY_A}${version.toString()}`,
      });
    }
    const pending: (() => void)[] = [];
    langfuse.intercept((url) =>
      url.pathname === "/api/public/v2/prompts"
        ? undefined
        : new Promise<Response>((resolve) => {
            pending.push(() => {
              resolve(json(500, {}));
            });
          }),
    );

    judge();
    judge();
    await settle();
    judge();

    expect(langfuse.listCalls()).toHaveLength(1);
    expect(langfuse.bodyCalls()).toHaveLength(2);
    for (const release of pending) {
      release();
    }
    await settle();
  });
});

describe("snapshot freshness and failures", () => {
  test("keeps the previous snapshot unusable when a rebuild fails, until the next one completes", async () => {
    const { langfuse, warm, judge, clock } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    expect((await warm())?.status).toBe("matched");

    langfuse.add("agents/reviewer", 2, { prompt: BODY_B });
    langfuse.intercept((url) =>
      url.searchParams.get("version") === "2"
        ? Promise.resolve(json(500, {}))
        : undefined,
    );
    clock.now += 46_000;
    judge();
    await settle();

    expect(judge()).toEqual({ name: "agents/reviewer", status: "unavailable" });

    langfuse.intercept(undefined);
    clock.now += 10_000;
    expect(await warm()).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 1,
    });
  });

  test("stops linking after a failed list even within 60 seconds", async () => {
    const { langfuse, warm, judge, clock } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    await warm();
    langfuse.intercept(() => Promise.resolve(json(503, {})));
    clock.now += 46_000;
    judge();
    await settle();

    expect(judge()).toEqual({ name: "agents/reviewer", status: "unavailable" });
  });

  test("refreshes ahead after 45 seconds and stops linking after 60 seconds without a new snapshot", async () => {
    const { langfuse, warm, judge, clock } = createLinking();
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    await warm();
    expect(langfuse.listCalls()).toHaveLength(1);

    clock.now += 45_000;
    judge();
    await settle();
    expect(langfuse.listCalls()).toHaveLength(1);

    langfuse.intercept(() => new Promise<Response>(() => undefined));
    clock.now += 1;
    expect(judge()?.status).toBe("matched");
    await settle();
    expect(langfuse.listCalls()).toHaveLength(2);

    clock.now += 15_000;
    expect(judge()).toEqual({ name: "agents/reviewer", status: "unavailable" });
  });

  test("retries failures with doubling backoff capped at ten minutes and resets after success", async () => {
    const { langfuse, judge, clock } = createLinking();
    langfuse.intercept(() => Promise.resolve(json(500, {})));
    const attemptsAfter = async (milliseconds: number) => {
      clock.now += milliseconds;
      judge();
      await settle();
      return langfuse.listCalls().length;
    };

    expect(await attemptsAfter(0)).toBe(1);
    expect(await attemptsAfter(9_999)).toBe(1);
    expect(await attemptsAfter(1)).toBe(2);
    expect(await attemptsAfter(19_999)).toBe(2);
    expect(await attemptsAfter(1)).toBe(3);
    expect(await attemptsAfter(40_000)).toBe(4);
    expect(await attemptsAfter(80_000)).toBe(5);
    expect(await attemptsAfter(160_000)).toBe(6);
    expect(await attemptsAfter(320_000)).toBe(7);
    expect(await attemptsAfter(599_999)).toBe(7);
    expect(await attemptsAfter(1)).toBe(8);
    expect(await attemptsAfter(600_000)).toBe(9);

    langfuse.intercept(undefined);
    langfuse.add("agents/reviewer", 1, { prompt: BODY_A });
    expect(await attemptsAfter(600_000)).toBe(10);
    expect(judge()?.status).toBe("matched");

    langfuse.intercept(() => Promise.resolve(json(500, {})));
    expect(await attemptsAfter(46_000)).toBe(11);
    expect(await attemptsAfter(9_999)).toBe(11);
    expect(await attemptsAfter(1)).toBe(12);
  });

  test("forces a refresh on no_match and links the new version that differs only in model", async () => {
    const { langfuse, warm, judge, clock } = createLinking();
    langfuse.add("agents/reviewer", 1, {
      prompt: BODY_A,
      config: { model: "provider-1/model-0" },
    });
    expect((await warm())?.status).toBe("no_match");
    expect(langfuse.listCalls()).toHaveLength(1);

    langfuse.add("agents/reviewer", 2, {
      prompt: BODY_A,
      config: { model: MODEL_REF },
    });
    clock.now += 9_999;
    judge();
    await settle();
    expect(langfuse.listCalls()).toHaveLength(1);

    clock.now += 1;
    expect(judge()?.status).toBe("no_match");
    await settle();
    expect(langfuse.listCalls()).toHaveLength(2);
    expect(judge()).toEqual({
      name: "agents/reviewer",
      status: "matched",
      version: 2,
    });
    expect(langfuse.bodyCalls()).toHaveLength(2);
  });
});

const INSTRUCTION = "policy/AGENTS";
const PV = {
  instructions: { path: "~/.config/opencode/AGENTS.md", prompt: INSTRUCTION },
};
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const createVersions = (options: unknown = { promptVersions: PV }) => {
  const langfuse = createLangfuse();
  const clock = { now: 1_000_000 };
  const warnings: string[] = [];
  const linking = new PromptLinking({
    baseUrl: BASE_URL,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    fetch: langfuse.fetch,
    now: () => clock.now,
    warn: (message) => {
      warnings.push(message);
    },
  });
  linking.register(options, "/h");

  const lookup = (body: string) =>
    linking.lookupInstruction(INSTRUCTION, sha256(body));
  // The first lookup starts the snapshot; the next one sees it.
  const warm = async (body: string) => {
    lookup(body);
    await settle();
    return lookup(body);
  };

  return { langfuse, clock, warnings, linking, lookup, warm };
};

describe("instruction prompt lookup", () => {
  test("registers policy/AGENTS and prefetches it when only promptVersions is given", async () => {
    const { langfuse, linking } = createVersions();

    expect(linking.linkingEnabled).toBe(false);
    expect(linking.versionsConfig).toMatchObject({
      instructionPath: "/h/.config/opencode/AGENTS.md",
      instructionPrompt: INSTRUCTION,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    await settle();
    expect(langfuse.listCalls().map((call) => call.url.search)).toEqual([
      "?name=policy%2FAGENTS&page=1&limit=100",
    ]);
  });

  test("matches the newest of identical bodies", async () => {
    const { langfuse, warm } = createVersions();
    langfuse.add(INSTRUCTION, 3, { prompt: "# A" });
    langfuse.add(INSTRUCTION, 4, { prompt: "# B" });
    langfuse.add(INSTRUCTION, 5, { prompt: "# A" });

    expect(await warm("# A")).toEqual({
      status: "matched",
      version: 5,
      hash: sha256("# A"),
    });
  });

  test("reports no_match for an unregistered body even when a registered prefix exists", async () => {
    const { langfuse, warm } = createVersions();
    langfuse.add(INSTRUCTION, 1, { prompt: "# P" });

    expect(await warm("# P\nextra")).toEqual({
      status: "no_match",
      hash: sha256("# P\nextra"),
    });
  });

  test("indexes only the newest 50 versions and stays usable past 200", async () => {
    const { langfuse, warm, lookup } = createVersions();
    for (let version = 1; version <= 230; version += 1) {
      langfuse.add(INSTRUCTION, version, {
        prompt: `# v${version.toString()}`,
      });
    }

    expect(await warm("# v181")).toMatchObject({
      status: "matched",
      version: 181,
    });
    expect(lookup("# v100").status).toBe("no_match");
    const fetched = langfuse
      .bodyCalls()
      .map((call) => Number(call.url.searchParams.get("version")))
      .sort((a, b) => a - b);
    expect(new Set(fetched)).toEqual(
      new Set(Array.from({ length: 50 }, (_, index) => 181 + index)),
    );
  });

  test("ignores model and variant config for the instruction prompt", async () => {
    const { langfuse, warm } = createVersions();
    langfuse.add(INSTRUCTION, 1, {
      prompt: "# A",
      config: { model: "x/y", variant: "" },
    });

    expect((await warm("# A")).status).toBe("matched");
  });

  test("excludes versions whose body has the delimiter shape", async () => {
    const { langfuse, warm, lookup } = createVersions();
    langfuse.add(INSTRUCTION, 1, { prompt: "# A" });
    langfuse.add(INSTRUCTION, 2, {
      prompt: "# B\n\nInstructions from: /x",
    });

    expect((await warm("# A")).status).toBe("matched");
    expect(lookup("# B\n\nInstructions from: /x").status).toBe("no_match");
  });

  test("follows the strict eligibility", async () => {
    const { langfuse, warm, lookup, clock } = createVersions();
    langfuse.add(INSTRUCTION, 1, { prompt: "# A" });
    expect((await warm("# A")).status).toBe("matched");

    langfuse.intercept(() => Promise.resolve(json(500, {})));
    clock.now += 46_000;
    lookup("# A");
    await settle();
    expect(lookup("# A")).toEqual({ status: "unavailable" });

    langfuse.intercept(undefined);
    clock.now += 10_000;
    expect((await warm("# A")).status).toBe("matched");
  });

  test("is unavailable for another name or when promptVersions is off", () => {
    const { linking } = createVersions({
      promptLinking: { agentPrompt: "agents/{agent}" },
    });
    expect(linking.versionsConfig).toBeUndefined();
    expect(linking.lookupInstruction(INSTRUCTION, sha256("# A"))).toEqual({
      status: "unavailable",
    });
  });
});

describe("promptVersions owner", () => {
  const LINK = { agentPrompt: "agents/{agent}" };

  test("keeps promptVersions for the same options", () => {
    const { linking, warnings } = createVersions({ promptVersions: PV });
    linking.register({ promptVersions: PV }, "/h");

    expect(linking.versionsConfig).toBeDefined();
    expect(warnings).toEqual([]);
  });

  test.each([
    ["invalid", { promptLinking: LINK, promptVersions: { instructions: {} } }],
    ["absent", { promptLinking: LINK }],
    [
      "different",
      {
        promptLinking: LINK,
        promptVersions: {
          instructions: { path: "/x/AGENTS.md", prompt: INSTRUCTION },
        },
      },
    ],
  ])(
    "disables only promptVersions when a later instance disagrees (%s)",
    (_name, later) => {
      const { linking, warnings } = createVersions({
        promptLinking: LINK,
        promptVersions: PV,
      });
      linking.register(later, "/h");

      expect(linking.versionsConfig).toBeUndefined();
      expect(linking.linkingEnabled).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("promptVersions");
    },
  );

  test("keeps promptVersions when a later instance only changes agentPrompt without overlap", () => {
    const { linking, warnings } = createVersions({
      promptLinking: LINK,
      promptVersions: PV,
    });
    linking.register(
      { promptLinking: { agentPrompt: "x/{agent}" }, promptVersions: PV },
      "/h",
    );

    expect(linking.linkingEnabled).toBe(false);
    expect(linking.versionsConfig).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("promptLinking");
  });

  test("disables promptVersions when a later instance's own agentPrompt overlaps", () => {
    const { linking, warnings } = createVersions({
      promptLinking: LINK,
      promptVersions: PV,
    });
    linking.register(
      { promptLinking: { agentPrompt: "policy/{agent}" }, promptVersions: PV },
      "/h",
    );

    expect(linking.versionsConfig).toBeUndefined();
    expect(linking.linkingEnabled).toBe(false);
    expect(warnings).toHaveLength(2);
    expect(
      warnings.filter((warning) => warning.includes("promptVersions")),
    ).toHaveLength(1);
    expect(
      warnings.filter((warning) => warning.includes("promptLinking")),
    ).toHaveLength(1);
  });

  test("warns once for invalid promptVersions on the first instance and keeps linking", () => {
    const { linking, warnings } = createVersions({
      promptLinking: LINK,
      promptVersions: { instructions: { path: "rel/a", prompt: INSTRUCTION } },
    });

    expect(linking.versionsConfig).toBeUndefined();
    expect(linking.linkingEnabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("rel/a");
  });
});
