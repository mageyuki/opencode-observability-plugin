import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { trace } from "@opentelemetry/api";
import { Effect, Schema } from "effect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { PROMPT_LINKING } from "../../src/prompt-link.js";
import { SESSION_HOLDS } from "../../src/session-holds.js";

// Drives the built OpenCode 2 entrypoint against a local server that plays
// both the Langfuse OTLP collector and the Prompt Management API, with
// promptVersions configured.

const OtlpValueSchema = Schema.Struct({
  stringValue: Schema.optional(Schema.String),
  boolValue: Schema.optional(Schema.Boolean),
  intValue: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});
const OtlpSpanSchema = Schema.Struct({
  name: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Array(
    Schema.Struct({ key: Schema.String, value: OtlpValueSchema }),
  ),
});
const OtlpBodySchema = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({ spans: Schema.Array(OtlpSpanSchema) }),
      ),
    }),
  ),
});

type OtlpSpan = typeof OtlpSpanSchema.Type;
type ExportedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
};

const golden = Schema.decodeUnknownSync(
  Schema.parseJson(Schema.Struct({ processors: Schema.Array(Schema.String) })),
)(
  readFileSync(
    new URL("./fixtures/v0.5.2-v2-golden.json", import.meta.url),
    "utf8",
  ),
);

const SetupContextSchema = Schema.declare(
  (
    input,
  ): input is Parameters<
    (typeof import("../../src/v2.js"))["default"]["setup"]
  >[0] => typeof input === "object" && input !== null,
);
const PluginModuleSchema = Schema.declare(
  (
    input,
  ): input is { default: (typeof import("../../src/v2.js"))["default"] } =>
    typeof input === "object" &&
    input !== null &&
    "default" in input &&
    typeof input.default === "object",
);

type HookHandler = (input: unknown) => void;

const originalEnvironment = {
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
  legacyBaseUrl: process.env.LANGFUSE_BASEURL,
  environment: process.env.LANGFUSE_ENVIRONMENT,
  userId: process.env.LANGFUSE_USER_ID,
  release: process.env.LANGFUSE_RELEASE,
};

const P = "/home/user/.config/opencode/AGENTS.md";
const INSTRUCTION = "policy/AGENTS";
const AGENTS_7 = "# Policy\nversion seven\n";
const AGENTS_8 = "# Policy\nversion eight\n";
const REVIEWER_PROMPT = "You are the reviewer.\nCheck every change.\n";
const PROVIDER_LINE = "p".repeat(57);
const PROMPTS: Partial<Record<string, Partial<Record<number, string>>>> = {
  [INSTRUCTION]: { 7: AGENTS_7, 8: AGENTS_8 },
  "agents/reviewer": { 3: REVIEWER_PROMPT },
};
const LINKING = {
  agentPrompt: "agents/{agent}",
  agents: { reviewer: "agents/reviewer" },
};
const PV = { instructions: { path: P, prompt: INSTRUCTION } };
const NEW_KEYS = new Set([
  "langfuse.release",
  "langfuse.version",
  ...[
    "agentsMdVersion",
    "agentsMdStatus",
    "agentsMdChanged",
    "agentsMdSha12",
    "agentPromptStatus",
    "otherInstructionCount",
    "promptVersionsSchema",
  ].map((key) => `langfuse.observation.metadata.${key}`),
]);
const model = { id: "model-1", providerID: "provider-1" };

const otlpSpans: OtlpSpan[] = [];
let promptRequests: string[] = [];
let promptHandler: (url: URL, response: ServerResponse) => void;
let server: Server;
let plugin: (typeof import("../../src/v2.js"))["default"];
const cleanups: (() => Promise<void>)[] = [];
// While set, the collector holds its answers to exports here, so a flush
// stays pending until the test lets them go.
let heldExports: (() => void)[] | undefined;

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });

const servePrompts = (url: URL, response: ServerResponse) => {
  const prefix = "/api/public/v2/prompts";
  response.writeHead(200, { "content-type": "application/json" });
  if (url.pathname === prefix) {
    const name = url.searchParams.get("name") ?? "";
    const versions = PROMPTS[name];
    response.end(
      JSON.stringify({
        data:
          versions === undefined
            ? []
            : [{ name, versions: Object.keys(versions).map(Number) }],
        meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
      }),
    );
    return;
  }
  const name = decodeURIComponent(url.pathname.slice(prefix.length + 1));
  const version = Number(url.searchParams.get("version"));
  response.end(
    JSON.stringify({
      name,
      version,
      type: "text",
      prompt: PROMPTS[name]?.[version] ?? "",
      config: {},
    }),
  );
};

const createEventQueue = () => {
  const items: unknown[] = [];
  const idleWaiters: (() => void)[] = [];
  let wake: (() => void) | undefined;

  return {
    subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          if (items.length > 0) {
            yield items.shift();
            continue;
          }
          for (const resolve of idleWaiters.splice(0)) {
            resolve();
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
          });
          wake = undefined;
        }
      },
    }),
    push: (event: unknown) => {
      items.push(event);
      wake?.();
    },
    idle: () =>
      new Promise<void>((resolve) => {
        if (items.length === 0 && wake !== undefined) {
          resolve();
          return;
        }
        idleWaiters.push(resolve);
      }),
  };
};

// `location` is the instance's `ctx.location`; without it the instance does
// not know its location, as in the older harness.
const startInstance = async (
  options?: unknown,
  location?: { directory: string },
) => {
  const hooks = new Map<string, HookHandler>();
  const queue = createEventQueue();
  const registration = { dispose: () => Promise.resolve() };
  const context = Schema.decodeUnknownSync(SetupContextSchema)({
    app: { version: "2.0.4" },
    ...(options === undefined ? {} : { options }),
    ...(location === undefined ? {} : { location }),
    session: {
      hook: (name: string, handler: HookHandler) => {
        hooks.set(`session.${name}`, handler);
        return Promise.resolve(registration);
      },
    },
    tool: {
      hook: (name: string, handler: HookHandler) => {
        hooks.set(`tool.${name}`, handler);
        return Promise.resolve(registration);
      },
    },
    event: { subscribe: queue.subscribe },
  });

  const cleanup = await plugin.setup(context);
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await cleanup?.();
  };
  cleanups.push(dispose);

  const hook = (name: string, input: unknown) => {
    const handler = hooks.get(name);
    if (!handler) {
      throw new Error(`Expected the plugin to register the ${name} hook`);
    }
    handler(input);
  };
  const emit = async (event: unknown) => {
    queue.push(event);
    await queue.idle();
  };
  // Delivers an event without waiting for the plugin to process it.
  const send = (event: unknown) => {
    queue.push(event);
  };

  return { hook, emit, send, dispose };
};

type Instance = Awaited<ReturnType<typeof startInstance>>;

const system = (agentsBody: string, terminated = true) => [
  { type: "text", text: PROVIDER_LINE },
  { type: "text", text: REVIEWER_PROMPT.trimEnd() },
  {
    type: "text",
    text: `catalog\n\nInstructions from: ${P}\n${agentsBody}${
      terminated ? "\n\nToday's date: Wed Oct 21 2026" : ""
    }`,
  },
];

const userPrompt = (
  instance: Instance,
  sessionID: string,
  messageID: string,
) => {
  instance.hook("session.prompt", {
    sessionID,
    messageID,
    prompt: { text: "Review the diff" },
  });
};

type GenerationInput = {
  sessionID: string;
  messageID: string;
  agent?: string;
  agentsBody?: string;
  terminated?: boolean;
  notice?: string;
};

const context = (instance: Instance, input: GenerationInput) => {
  instance.hook("session.context", {
    sessionID: input.sessionID,
    agent: input.agent ?? "reviewer",
    model,
    system: system(input.agentsBody ?? AGENTS_7, input.terminated ?? true),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: input.notice ?? "Review the diff" }],
      },
    ],
    tools: {},
    options: {},
  });
};

const stepStarted = (instance: Instance, input: GenerationInput) =>
  instance.emit({
    type: "session.step.started",
    id: `${input.messageID}-started`,
    created: Date.now(),
    data: {
      sessionID: input.sessionID,
      assistantMessageID: input.messageID,
      agent: input.agent ?? "reviewer",
      model,
      snapshot: "snapshot",
    },
  });

const stepEnded = (instance: Instance, input: GenerationInput) =>
  instance.emit({
    type: "session.step.ended",
    id: `${input.messageID}-ended`,
    created: Date.now(),
    data: {
      sessionID: input.sessionID,
      assistantMessageID: input.messageID,
      finish: "stop",
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  });

const runGeneration = async (instance: Instance, input: GenerationInput) => {
  context(instance, input);
  await stepStarted(instance, input);
  await stepEnded(instance, input);
};

const finishSession = (instance: Instance, sessionID: string) =>
  instance.emit({
    type: "session.execution.succeeded",
    id: `${sessionID}-done-${Date.now().toString()}`,
    created: Date.now(),
    data: { sessionID },
  });

// The shape evaluation-grains' emitSpan uses for a task.
const emitTask = (sessionID: string, startTime: number) => {
  const span = trace
    .getTracer("opencode-langfuse-plugin")
    .startSpan("opencode.task", {
      root: true,
      startTime,
      attributes: { "session.id": sessionID },
    });
  span.end();
};

const attributeValue = (value: OtlpSpan["attributes"][number]["value"]) => {
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.intValue !== undefined) {
    return Number(value.intValue);
  }
  throw new Error("Unexpected OTLP attribute value");
};

const exportedSpans = async (minimum: number): Promise<ExportedSpan[]> => {
  await vi.waitFor(() => {
    expect(otlpSpans.length).toBeGreaterThanOrEqual(minimum);
  });
  return otlpSpans.map((span) => ({
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined || span.parentSpanId === ""
      ? {}
      : { parentSpanId: span.parentSpanId }),
    attributes: Object.fromEntries(
      span.attributes.map(({ key, value }) => [key, attributeValue(value)]),
    ),
  }));
};

const named = (spans: readonly ExportedSpan[], name: string) =>
  spans.filter((span) => span.name === name).map((span) => span.attributes);

const metadata = (key: string) => `langfuse.observation.metadata.${key}`;

const processors = () => {
  const proxy = trace.getTracerProvider();
  const getDelegate: unknown = Reflect.get(proxy, "getDelegate");
  if (typeof getDelegate !== "function") {
    throw new Error("Expected the global proxy tracer provider");
  }
  const provider: unknown = Reflect.apply(getDelegate, proxy, []);
  const active: unknown =
    typeof provider === "object" && provider !== null
      ? Reflect.get(provider, "_activeSpanProcessor")
      : undefined;
  const list: unknown =
    typeof active === "object" && active !== null
      ? Reflect.get(active, "_spanProcessors")
      : undefined;
  if (!Array.isArray(list)) {
    throw new Error("Expected a NodeTracerProvider with span processors");
  }
  return list.map((processor: unknown) =>
    typeof processor === "object" && processor !== null
      ? {
          name: processor.constructor.name,
          keys: Object.keys(processor).sort().join(","),
        }
      : { name: typeof processor, keys: "" },
  );
};

const promptsSettled = async (count: number) => {
  await vi.waitFor(() => {
    expect(promptRequests.length).toBeGreaterThanOrEqual(count);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
};

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

// Starts an instance whose policy/AGENTS and agents/reviewer snapshots are
// ready (two lists and three bodies).
const startReady = async (
  options: unknown = { promptLinking: LINKING, promptVersions: PV },
  location?: { directory: string },
) => {
  const instance = await startInstance(options, location);
  await promptsSettled(5);
  return instance;
};

// A client built from the sources, which the built entrypoint then shares;
// it gives the test the hooks of the client.
const sourceClient = async () => {
  vi.stubGlobal("__PLUGIN_VERSION__", "source");
  const { createLangfuseRuntime } = await import("../../src/runtime.js");
  return Effect.runPromise(createLangfuseRuntime({ opencodeVersion: "2.0.4" }));
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/public/v2/prompts")) {
      promptRequests.push(`${url.pathname}${url.search}`);
      promptHandler(url, response);
      return;
    }
    void readBody(request).then((body) => {
      if (url.pathname.endsWith("/v1/traces")) {
        const parsed = Schema.decodeUnknownSync(
          Schema.parseJson(OtlpBodySchema),
        )(body);
        otlpSpans.push(
          ...parsed.resourceSpans.flatMap((resourceSpan) =>
            resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
          ),
        );
      }
      const answer = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      };
      if (heldExports !== undefined && url.pathname.endsWith("/v1/traces")) {
        heldExports.push(answer);
        return;
      }
      answer();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on a TCP port");
  }

  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-secret";
  process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${address.port.toString()}`;
  process.env.LANGFUSE_ENVIRONMENT = "integration-test";
  process.env.LANGFUSE_USER_ID = "test-user";
  delete process.env.LANGFUSE_BASEURL;
  delete process.env.LANGFUSE_RELEASE;

  const builtPlugin: unknown = await import(
    new URL("../../dist/v2/index.js", import.meta.url).href
  );
  plugin = Schema.decodeUnknownSync(PluginModuleSchema)(builtPlugin).default;
});

beforeEach(() => {
  heldExports = undefined;
  otlpSpans.length = 0;
  promptRequests = [];
  promptHandler = servePrompts;
});

const reset = async () => {
  for (const dispose of cleanups.splice(0)) {
    await dispose();
  }
  trace.disable();
  globalThis.langfuseOpencodeRuntimeState = undefined;
};

afterEach(async () => {
  await reset();
  delete process.env.LANGFUSE_RELEASE;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  for (const [name, value] of Object.entries({
    LANGFUSE_PUBLIC_KEY: originalEnvironment.publicKey,
    LANGFUSE_SECRET_KEY: originalEnvironment.secretKey,
    LANGFUSE_BASE_URL: originalEnvironment.baseUrl,
    LANGFUSE_BASEURL: originalEnvironment.legacyBaseUrl,
    LANGFUSE_ENVIRONMENT: originalEnvironment.environment,
    LANGFUSE_USER_ID: originalEnvironment.userId,
    LANGFUSE_RELEASE: originalEnvironment.release,
  })) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

// One turn with one generation of the given input.
const oneTurn = async (
  instance: Instance,
  input: Partial<GenerationInput> = {},
) => {
  const sessionID = input.sessionID ?? "session-1";
  userPrompt(instance, sessionID, `${sessionID}-user`);
  await runGeneration(instance, {
    sessionID,
    messageID: `${sessionID}-assistant`,
    ...input,
  });
  await finishSession(instance, sessionID);
};

describe("OpenCode 2 prompt versions", { concurrent: false }, () => {
  test("adds nothing without promptVersions", async () => {
    const instance = await startInstance({ promptLinking: LINKING });
    await promptsSettled(2);
    await oneTurn(instance);

    const spans = await exportedSpans(3);
    for (const span of spans) {
      expect(
        Object.keys(span.attributes).filter((key) => NEW_KEYS.has(key)),
      ).toEqual([]);
    }
  });

  test("stamps generation and turn with the matched versions", async () => {
    const instance = await startReady();
    await oneTurn(instance);

    const spans = await exportedSpans(3);
    const expected = {
      "langfuse.release": "policy/AGENTS@7",
      "langfuse.version": "agents/reviewer@3",
      [metadata("agentsMdStatus")]: "matched",
      [metadata("agentsMdVersion")]: "7",
      [metadata("otherInstructionCount")]: "0",
      [metadata("promptVersionsSchema")]: "1",
    };
    expect(named(spans, "opencode.generation")).toEqual([
      expect.objectContaining(expected),
    ]);
    expect(named(spans, "opencode.turn")).toEqual([
      expect.objectContaining(expected),
    ]);
  });

  test("names unregistered agents without a hash", async () => {
    const instance = await startReady();
    userPrompt(instance, "session-1", "session-1-user");
    const input = {
      sessionID: "session-1",
      messageID: "session-1-assistant",
      agent: "build",
    };
    context(instance, input);
    await stepStarted(instance, input);
    await promptsSettled(6);
    await stepEnded(instance, input);
    await finishSession(instance, "session-1");

    const generation = named(await exportedSpans(3), "opencode.generation").at(
      0,
    );
    expect(generation).toMatchObject({
      "langfuse.version": "build",
      [metadata("agentPromptStatus")]: "not_registered",
    });
    expect(
      Object.keys(generation ?? {}).filter((key) => key.includes("Sha12")),
    ).toEqual([metadata("agentsMdSha12")]);
  });

  test("marks a turn mixed when its generations differ", async () => {
    const instance = await startReady();
    userPrompt(instance, "session-1", "session-1-user");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-1",
    });
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-2",
      notice: `The instructions from ${P} changed. Here's the diff:\n\`\`\`diff\n@@ -1 +1 @@\n\`\`\``,
    });
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(4);
    expect(
      named(spans, "opencode.generation").map(
        (span) => span["langfuse.release"],
      ),
    ).toEqual(["policy/AGENTS@7", "policy/AGENTS@7+changed"]);
    expect(named(spans, "opencode.turn")).toEqual([
      expect.objectContaining({
        "langfuse.release": "policy/AGENTS:mixed",
        [metadata("agentsMdChanged")]: "true",
      }),
    ]);
  });

  test("stamps a backdated root span from the session window", async () => {
    const instance = await startReady();
    const before = Date.now();
    await oneTurn(instance);
    emitTask("session-1", before);
    await finishSession(instance, "session-1");

    const task = named(await exportedSpans(4), "opencode.task").at(0);
    expect(task?.["langfuse.release"]).toBe("policy/AGENTS@7");
  });

  test("is unavailable for a backdated span from before the process started", async () => {
    const before = Date.now();
    const instance = await startReady();
    await oneTurn(instance);
    emitTask("session-1", before - 1_000);
    await finishSession(instance, "session-1");

    const task = named(await exportedSpans(4), "opencode.task").at(0);
    expect(task?.["langfuse.release"]).toBeUndefined();
    expect(task?.[metadata("agentsMdStatus")]).toBe("unavailable");
  });

  test("keeps our release when LANGFUSE_RELEASE is set", async () => {
    process.env.LANGFUSE_RELEASE = "env-release";
    const instance = await startReady();
    await oneTurn(instance);

    const spans = await exportedSpans(3);
    for (const name of ["opencode.generation", "opencode.turn"]) {
      expect(named(spans, name)[0]?.["langfuse.release"]).toBe(
        "policy/AGENTS@7",
      );
    }
  });

  test("does not change the span processors", async () => {
    await startReady();
    const list = processors();

    expect(list.map((processor) => processor.name)).toEqual(golden.processors);
    for (const processor of list) {
      if (processor.name !== "LangfuseSpanProcessor") {
        expect(processor.keys).toBe("forceFlush,onEnd,onStart,shutdown");
      }
    }
  });

  test("writes no instruction text or path in the new attributes", async () => {
    const instance = await startReady();
    const before = Date.now();
    await oneTurn(instance);
    emitTask("session-1", before);
    await finishSession(instance, "session-1");

    const patterns: Record<string, RegExp> = {
      "langfuse.release":
        /^(policy\/AGENTS(@\d+|#[0-9a-f]{12})(\+changed)?|policy\/AGENTS:mixed)$/,
      "langfuse.version": /^[A-Za-z0-9._/-]+(@\d+)?$|^mixed$/,
      [metadata("agentsMdStatus")]:
        /^(matched|no_match|absent|ambiguous|boundary_unknown|unavailable|mixed)$/,
      [metadata("agentPromptStatus")]:
        /^(matched|not_registered|no_match|ambiguous|unavailable|disabled|mixed)$/,
      [metadata("agentsMdSha12")]: /^[0-9a-f]{12}$/,
      [metadata("agentsMdVersion")]: /^\d+$/,
      [metadata("agentsMdChanged")]: /^(true|false)$/,
      [metadata("otherInstructionCount")]: /^\d+$/,
      [metadata("promptVersionsSchema")]: /^1$/,
    };
    const spans = await exportedSpans(4);
    let checked = 0;
    for (const span of spans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        if (!NEW_KEYS.has(key)) {
          continue;
        }
        checked += 1;
        expect(String(value)).toMatch(patterns[key] ?? /^$/);
        expect(String(value)).not.toContain("Policy");
        expect(String(value)).not.toContain(P);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("causes no Langfuse SDK warning about the new metadata", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const instance = await startReady();
    const before = Date.now();
    await oneTurn(instance);
    emitTask("session-1", before);
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(4);
    expect(
      spans.some((span) =>
        Object.keys(span.attributes).some((key) => NEW_KEYS.has(key)),
      ),
    ).toBe(true);
    expect(
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((warning) => warning.includes("not a stringified object")),
    ).toEqual([]);
  });

  test("boundary_unknown leaves release unset", async () => {
    const instance = await startReady();
    await oneTurn(instance, { terminated: false });

    const generation = named(await exportedSpans(3), "opencode.generation").at(
      0,
    );
    expect(generation?.["langfuse.release"]).toBeUndefined();
    expect(generation?.[metadata("agentsMdStatus")]).toBe("boundary_unknown");
  });

  test("does not carry @7 into a later boundary_unknown generation", async () => {
    const instance = await startReady();
    userPrompt(instance, "session-1", "user-1");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-1",
    });
    userPrompt(instance, "session-1", "user-2");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-2",
      terminated: false,
    });
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(6);
    for (const name of ["opencode.generation", "opencode.turn"]) {
      const second = named(spans, name).at(1);
      expect(second?.["langfuse.release"]).toBeUndefined();
      expect(second?.[metadata("agentsMdStatus")]).toBe("boundary_unknown");
    }
  });

  test("stamps matched then mixed only as mixed", async () => {
    const instance = await startReady();
    userPrompt(instance, "session-1", "user-1");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-1",
    });
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-2",
      agentsBody: AGENTS_8,
    });
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(4);
    expect(
      named(spans, "opencode.generation").map(
        (span) => span["langfuse.release"],
      ),
    ).toEqual(["policy/AGENTS@7", "policy/AGENTS@8"]);
    expect(named(spans, "opencode.turn")[0]?.["langfuse.release"]).toBe(
      "policy/AGENTS:mixed",
    );
  });

  test("resolves a cold start at the end without mixing", async () => {
    const held: ServerResponse[] = [];
    promptHandler = (url, response) => {
      if (url.searchParams.get("name") === INSTRUCTION) {
        held.push(response);
        return;
      }
      servePrompts(url, response);
    };
    const instance = await startInstance({
      promptLinking: LINKING,
      promptVersions: PV,
    });
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    await promptsSettled(3);

    const before = Date.now();
    const input = { sessionID: "session-1", messageID: "assistant-1" };
    userPrompt(instance, "session-1", "user-1");
    context(instance, input);
    await stepStarted(instance, input);
    promptHandler = servePrompts;
    for (const response of held) {
      servePrompts(
        new URL(`http://127.0.0.1/api/public/v2/prompts?name=${INSTRUCTION}`),
        response,
      );
    }
    await promptsSettled(5);
    await stepEnded(instance, input);
    emitTask("session-1", before);
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(4);
    for (const name of [
      "opencode.generation",
      "opencode.turn",
      "opencode.task",
    ]) {
      expect(named(spans, name)[0]?.["langfuse.release"]).toBe(
        "policy/AGENTS@7",
      );
    }
  });

  test("does not use a link result after prompt linking was disabled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held: ServerResponse[] = [];
    promptHandler = (url, response) => {
      if (url.searchParams.get("name") === INSTRUCTION) {
        held.push(response);
        return;
      }
      servePrompts(url, response);
    };
    const instance = await startInstance({
      promptLinking: LINKING,
      promptVersions: PV,
    });
    await promptsSettled(3);

    // The link is matched at start; the instruction is not resolved yet.
    const input = { sessionID: "session-1", messageID: "assistant-1" };
    userPrompt(instance, "session-1", "user-1");
    context(instance, input);
    await stepStarted(instance, input);
    // A re-created instance with other promptLinking turns linking off.
    await startInstance({
      promptLinking: { agentPrompt: "other/{agent}" },
      promptVersions: PV,
    });
    promptHandler = servePrompts;
    for (const response of held) {
      servePrompts(
        new URL(`http://127.0.0.1/api/public/v2/prompts?name=${INSTRUCTION}`),
        response,
      );
    }
    await promptsSettled(5);
    await stepEnded(instance, input);
    await finishSession(instance, "session-1");

    const generation = named(await exportedSpans(3), "opencode.generation").at(
      0,
    );
    expect(generation).toMatchObject({
      "langfuse.release": "policy/AGENTS@7",
      "langfuse.version": "reviewer",
      [metadata("agentPromptStatus")]: "disabled",
    });
  });

  test("updates one entry when the end re-determination resolves the link", async () => {
    const instance = await startInstance({
      promptLinking: { agentPrompt: "agents/{agent}" },
      promptVersions: PV,
    });
    await promptsSettled(3);
    const input = { sessionID: "session-1", messageID: "assistant-1" };
    userPrompt(instance, "session-1", "user-1");
    context(instance, input);
    await stepStarted(instance, input);
    await promptsSettled(5);
    await stepEnded(instance, input);
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(3);
    for (const name of ["opencode.generation", "opencode.turn"]) {
      expect(named(spans, name)[0]?.["langfuse.version"]).toBe(
        "agents/reviewer@3",
      );
    }
  });

  test("omits release and version on a task-shaped span while a generation is pending", async () => {
    const client = await sourceClient();
    const held: ServerResponse[] = [];
    promptHandler = (url, response) => {
      if (url.searchParams.get("name") === "agents/reviewer") {
        held.push(response);
        return;
      }
      servePrompts(url, response);
    };
    const instance = await startInstance({
      promptLinking: {
        agentPrompt: "agents/{agent}",
        agents: { build: "agents/build" },
      },
      promptVersions: PV,
    });
    await promptsSettled(4);

    const before = Date.now();
    userPrompt(instance, "session-1", "user-1");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-a",
      agent: "build",
    });
    const pending = { sessionID: "session-1", messageID: "assistant-b" };
    context(instance, pending);
    await stepStarted(instance, pending);
    expect(client.debugPromptVersionState().pending("session-1")).toBe(1);
    emitTask("session-1", before);

    promptHandler = servePrompts;
    for (const response of held) {
      servePrompts(
        new URL("http://127.0.0.1/api/public/v2/prompts?name=agents/reviewer"),
        response,
      );
    }
    await promptsSettled(6);
    await stepEnded(instance, pending);
    emitTask("session-1", before);
    await finishSession(instance, "session-1");

    const tasks = named(await exportedSpans(6), "opencode.task");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.["langfuse.release"]).toBeUndefined();
    expect(tasks[0]?.["langfuse.version"]).toBeUndefined();
    expect(tasks[0]?.[metadata("agentsMdStatus")]).toBe("unavailable");
    expect(tasks[1]?.["langfuse.release"]).toBe("policy/AGENTS@7");
  });

  test("uses only the generations determined inside a task window", async () => {
    const instance = await startReady();
    userPrompt(instance, "session-1", "user-1");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-a",
    });
    await pause(5);
    const windowStart = Date.now();
    await pause(5);
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-b",
      agentsBody: AGENTS_8,
    });
    emitTask("session-1", windowStart);
    await finishSession(instance, "session-1");

    const task = named(await exportedSpans(5), "opencode.task").at(0);
    expect(task?.["langfuse.release"]).toBe("policy/AGENTS@8");
  });

  test("survives a failure in the new feature", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = await sourceClient();
    const linking = client[PROMPT_LINKING];
    vi.spyOn(linking, "lookupInstruction").mockImplementationOnce(() => {
      throw new TypeError(`secret ${AGENTS_7}`);
    });
    const instance = await startReady();
    const before = Date.now();
    userPrompt(instance, "session-1", "user-1");
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-1",
    });
    await runGeneration(instance, {
      sessionID: "session-1",
      messageID: "assistant-2",
    });
    await finishSession(instance, "session-1");
    emitTask("session-1", before);
    await finishSession(instance, "session-1");

    const spans = await exportedSpans(5);
    const generations = named(spans, "opencode.generation");
    expect(generations).toHaveLength(2);
    expect(
      Object.keys(generations[0] ?? {}).filter((key) => NEW_KEYS.has(key)),
    ).toEqual([]);
    expect(generations[1]?.["langfuse.release"]).toBe("policy/AGENTS@7");
    expect(named(spans, "opencode.turn")[0]?.["langfuse.release"]).toBe(
      "policy/AGENTS@7",
    );
    expect(named(spans, "opencode.task")[0]?.["langfuse.release"]).toBe(
      "policy/AGENTS@7",
    );
    // Only the fault boundary's warning is counted: the Langfuse SDK also
    // warns once per non-string `langfuse.observation.metadata.*` attribute
    // at export (MediaService), which is reported separately.
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.filter((warning) =>
        warning.startsWith("[Langfuse prompt versions]"),
      ),
    ).toEqual([
      "[Langfuse prompt versions] internal error (TypeError); prompt version attributes skipped",
    ]);
    for (const warning of warnings) {
      expect(warning).not.toContain("Policy");
      expect(warning).not.toContain("secret");
    }
  });

  test("keeps input, output and existing metadata identical", async () => {
    const run = async (options: unknown, requests: number) => {
      otlpSpans.length = 0;
      promptRequests = [];
      const instance = await startInstance(options);
      await promptsSettled(requests);
      await oneTurn(instance);
      const spans = await exportedSpans(3);
      await reset();
      return spans.map((span) => ({
        name: span.name,
        attributes: Object.fromEntries(
          Object.entries(span.attributes).filter(([key]) => !NEW_KEYS.has(key)),
        ),
      }));
    };

    const without = await run({ promptLinking: LINKING }, 2);
    const withVersions = await run(
      { promptLinking: LINKING, promptVersions: PV },
      5,
    );
    expect(withVersions).toEqual(without);
  });
});

const OPTIONS = { promptLinking: LINKING, promptVersions: PV };
const A = { directory: "/a" };
const B = { directory: "/b" };

const flushed = async (client: {
  forceFlush: Effect.Effect<void, unknown>;
}) => {
  await Effect.runPromise(client.forceFlush);
  return exportedSpans(0);
};

const TurnMetadataSchema = Schema.parseJson(
  Schema.Struct({
    messageID: Schema.optional(Schema.String),
    parentSessionID: Schema.optional(Schema.String),
  }),
);

// The turns of one session, with their metadata.
const turnsOf = (spans: readonly ExportedSpan[], sessionID: string) =>
  spans
    .filter(
      (span) =>
        span.name === "opencode.turn" &&
        span.attributes["session.id"] === sessionID,
    )
    .map((span) => ({
      ...span,
      metadata: Schema.decodeUnknownSync(TurnMetadataSchema)(
        span.attributes["langfuse.observation.metadata"],
      ),
    }));

const moved = (sessionID: string, directory: string, seq: number) => ({
  type: "session.moved",
  id: `${sessionID}-moved-${seq.toString()}`,
  created: Date.now(),
  durable: { aggregateID: sessionID, seq, version: 1 },
  data: { sessionID, location: { directory }, projectID: "project-1" },
});

const created = (sessionID: string, parentID: string) => ({
  type: "session.created",
  id: `${sessionID}-created`,
  created: Date.now(),
  data: { sessionID, parentID },
});

describe("OpenCode 2 location disposal", { concurrent: false }, () => {
  test("keeps another location's open turn and its history", async () => {
    const client = await sourceClient();
    const a = await startReady();
    const b = await startInstance(OPTIONS);
    const before = Date.now();
    userPrompt(b, "session-b", "session-b-user");
    await runGeneration(b, {
      sessionID: "session-b",
      messageID: "session-b-assistant-1",
    });

    await a.dispose();
    expect(named(await flushed(client), "opencode.turn")).toEqual([]);

    // Attributed from the history determined before the disposal only.
    emitTask("session-b", before);
    expect(
      named(await flushed(client), "opencode.task")[0]?.["langfuse.release"],
    ).toBe("policy/AGENTS@7");

    await runGeneration(b, {
      sessionID: "session-b",
      messageID: "session-b-assistant-2",
    });
    await finishSession(b, "session-b");
    expect(named(await flushed(client), "opencode.turn")).toEqual([
      expect.objectContaining({ "langfuse.release": "policy/AGENTS@7" }),
    ]);
  });

  test("keeps the history of a finished session after its location is disposed", async () => {
    const client = await sourceClient();
    const a = await startReady();
    const before = Date.now();
    await oneTurn(a, { sessionID: "session-a" });
    await a.dispose();

    emitTask("session-a", before);
    const task = named(await flushed(client), "opencode.task").at(0);
    expect(task?.["langfuse.release"]).toBe("policy/AGENTS@7");
  });

  test("marks a task of a session without history unavailable", async () => {
    const client = await sourceClient();
    await startReady();

    emitTask("session-unknown", Date.now());
    const task = named(await flushed(client), "opencode.task").at(0);
    expect(task?.["langfuse.release"]).toBeUndefined();
    expect(task?.["langfuse.version"]).toBeUndefined();
    expect(task?.[metadata("agentsMdStatus")]).toBe("unavailable");
  });

  test("ends and exports the open turn of a session it held", async () => {
    const a = await startReady();
    userPrompt(a, "session-a", "session-a-user");
    const input = { sessionID: "session-a", messageID: "session-a-assistant" };
    context(a, input);
    await stepStarted(a, input);

    await a.dispose();
    const spans = await exportedSpans(3);
    for (const name of ["opencode.generation", "opencode.turn"]) {
      expect(named(spans, name)).toEqual([
        expect.objectContaining({ "langfuse.release": "policy/AGENTS@7" }),
      ]);
    }
  });

  test("works with a shared client that has no session holds", async () => {
    const client = await sourceClient();
    Reflect.deleteProperty(client, SESSION_HOLDS);
    const a = await startReady();
    await oneTurn(a);
    userPrompt(a, "session-2", "session-2-user");

    await expect(a.dispose()).resolves.toBeUndefined();
    expect(named(await flushed(client), "opencode.turn")).toHaveLength(1);
  });

  test("keeps a child's parent link across a disposal", async () => {
    const a = await startReady();
    await oneTurn(a, { sessionID: "p" });
    await a.emit(created("c", "p"));
    await oneTurn(a, { sessionID: "c" });
    await a.dispose();

    const a2 = await startInstance(OPTIONS);
    userPrompt(a2, "p", "p-user-2");
    const parentStep = { sessionID: "p", messageID: "p-assistant-2" };
    context(a2, parentStep);
    await stepStarted(a2, parentStep);
    userPrompt(a2, "c", "c-user-2");
    await finishSession(a2, "c");
    await finishSession(a2, "p");

    const spans = await exportedSpans(8);
    const child = turnsOf(spans, "c").find(
      (turn) => turn.metadata.messageID === "c-user-2",
    );
    const parent = spans.find((span) => span.spanId === child?.parentSpanId);
    expect(child?.metadata.parentSessionID).toBe("p");
    expect(parent?.name).toBe("opencode.generation");
    expect(parent?.attributes["session.id"]).toBe("p");
    expect(parent?.traceId).toBe(child?.traceId);
  });

  test("ignores late events of an instance that no longer holds the session", async () => {
    const client = await sourceClient();
    const a = await startReady();
    const b = await startInstance(OPTIONS);
    await oneTurn(a, { sessionID: "session-s" });
    userPrompt(b, "session-s", "session-s-user-2");
    await runGeneration(b, {
      sessionID: "session-s",
      messageID: "session-s-assistant-2",
    });

    await stepStarted(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-late",
    });
    await finishSession(a, "session-s");
    expect(turnsOf(await flushed(client), "session-s")).toHaveLength(1);
    await a.dispose();
    expect(turnsOf(await flushed(client), "session-s")).toHaveLength(1);

    await finishSession(b, "session-s");
    const turns = turnsOf(await flushed(client), "session-s");
    expect(turns).toHaveLength(2);
    expect(
      turns
        .filter((turn) => turn.metadata.messageID === "session-s-user-2")
        .map((turn) => turn.attributes["langfuse.release"]),
    ).toEqual(["policy/AGENTS@7"]);
  });

  test("does nothing for a hook called after the disposal", async () => {
    const client = await sourceClient();
    const a = await startReady();
    await a.dispose();

    userPrompt(a, "session-x", "session-x-user");
    const spans = await flushed(client);
    expect(named(spans, "opencode.message.user")).toEqual([]);
    expect(named(spans, "opencode.turn")).toEqual([]);
    expect(
      client.debugSessionState("session-x", ["session-x-user"]),
    ).toMatchObject({ entries: 0, holder: undefined });
  });

  test("keeps the hold at the moved-to location when an old hook runs late", async () => {
    const client = await sourceClient();
    const a = await startReady(OPTIONS, A);
    const b = await startInstance(OPTIONS, B);
    userPrompt(a, "session-s", "session-s-user-1");
    await runGeneration(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-1",
    });
    await a.emit(moved("session-s", "/b", 1));
    await b.emit(moved("session-s", "/b", 1));

    // The late hook's content is real, so it opens the turn; it does not
    // take the session back, so A's late run event does not end that turn.
    userPrompt(a, "session-s", "session-s-user-2");
    await finishSession(a, "session-s");
    expect(
      turnsOf(await flushed(client), "session-s").map(
        (turn) => turn.metadata.messageID,
      ),
    ).toEqual(["session-s-user-1"]);
    await runGeneration(b, {
      sessionID: "session-s",
      messageID: "session-s-assistant-2",
    });
    await a.dispose();
    expect(
      turnsOf(await flushed(client), "session-s").map(
        (turn) => turn.metadata.messageID,
      ),
    ).toEqual(["session-s-user-1"]);

    await finishSession(b, "session-s");
    const spans = await flushed(client);
    expect(
      turnsOf(spans, "session-s").map((turn) => turn.metadata.messageID),
    ).toEqual(["session-s-user-1", "session-s-user-2"]);
    expect(named(spans, "opencode.generation")).toHaveLength(2);
    expect(client.debugSessionState("session-s")).toMatchObject({
      location: "/b",
      holder: "/b",
    });
  });

  test("ignores the old location's events once the move is recorded", async () => {
    const client = await sourceClient();
    const a = await startReady(OPTIONS, A);
    const b = await startInstance(OPTIONS, B);
    userPrompt(a, "session-s", "session-s-user-1");
    await runGeneration(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-1",
    });
    // A takes the hold back with a hook before anyone recorded the move.
    userPrompt(a, "session-s", "session-s-user-2");
    await b.emit(moved("session-s", "/b", 1));

    await finishSession(a, "session-s");
    expect(
      turnsOf(await flushed(client), "session-s").map(
        (turn) => turn.metadata.messageID,
      ),
    ).toEqual(["session-s-user-1"]);

    await runGeneration(b, {
      sessionID: "session-s",
      messageID: "session-s-assistant-2",
    });
    await finishSession(b, "session-s");
    expect(
      turnsOf(await flushed(client), "session-s").map(
        (turn) => turn.metadata.messageID,
      ),
    ).toEqual(["session-s-user-1", "session-s-user-2"]);
    expect(client.debugSessionState("session-s").holder).toBe("/b");
  });

  test("ignores an older move", async () => {
    const client = await sourceClient();
    const a = await startReady(OPTIONS, A);
    const b = await startInstance(OPTIONS, B);
    userPrompt(a, "session-s", "session-s-user-1");
    await runGeneration(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-1",
    });
    await a.emit(moved("session-s", "/b", 2));
    await b.emit(moved("session-s", "/b", 2));
    userPrompt(b, "session-s", "session-s-user-2");
    await runGeneration(b, {
      sessionID: "session-s",
      messageID: "session-s-assistant-2",
    });

    await a.emit(moved("session-s", "/a", 1));
    await finishSession(a, "session-s");
    expect(turnsOf(await flushed(client), "session-s")).toHaveLength(1);

    await finishSession(b, "session-s");
    expect(turnsOf(await flushed(client), "session-s")).toHaveLength(2);
    expect(client.debugSessionState("session-s")).toMatchObject({
      location: "/b",
      holder: "/b",
    });
  });

  test("records a late parent link of a session another location holds", async () => {
    const client = await sourceClient();
    const a = await startReady(OPTIONS, A);
    const b = await startInstance(OPTIONS, B);
    userPrompt(a, "p", "p-user-1");
    await b.emit(moved("c", "/b", 1));
    userPrompt(b, "c", "c-user-1");
    await a.emit(created("c", "p"));
    const parentStep = { sessionID: "p", messageID: "p-assistant-1" };
    context(a, parentStep);
    await stepStarted(a, parentStep);

    userPrompt(b, "c", "c-user-2");
    await a.dispose();
    userPrompt(b, "c", "c-user-3");
    await finishSession(b, "c");

    const spans = await flushed(client);
    const turns = turnsOf(spans, "c");
    const second = turns.find((turn) => turn.metadata.messageID === "c-user-2");
    const parent = spans.find((span) => span.spanId === second?.parentSpanId);
    expect(second?.metadata.parentSessionID).toBe("p");
    expect(parent?.name).toBe("opencode.generation");
    expect(parent?.attributes["session.id"]).toBe("p");
    expect(
      turns.find((turn) => turn.metadata.messageID === "c-user-3")?.metadata
        .parentSessionID,
    ).toBe("p");
  });

  // A holds session-s at its recorded location /a. Its event loop waits on
  // the flush after the run, the move to /b is queued behind it, and A's
  // cleanup starts before the move is read, so the record stays /a.
  const loseMoveInDisposal = async (client: {
    forceFlush: Effect.Effect<void, unknown>;
  }) => {
    const a = await startReady(OPTIONS, A);
    await a.emit(moved("session-s", "/a", 1));
    userPrompt(a, "session-s", "session-s-user-1");
    await runGeneration(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-1",
    });

    heldExports = [];
    a.send({
      type: "session.execution.succeeded",
      id: "session-s-done-1",
      created: Date.now(),
      data: { sessionID: "session-s" },
    });
    a.send(moved("session-s", "/b", 2));
    await vi.waitFor(() => {
      expect(heldExports?.length).toBeGreaterThan(0);
    });
    const disposing = a.dispose();
    const held = heldExports;
    heldExports = undefined;
    for (const answer of held) {
      answer();
    }
    await disposing;
    await Effect.runPromise(client.forceFlush);
  };

  // B, started after the move, never receives it.
  const runAtB = async () => {
    const b = await startInstance(OPTIONS, B);
    userPrompt(b, "session-s", "session-s-user-2");
    await runGeneration(b, {
      sessionID: "session-s",
      messageID: "session-s-assistant-2",
    });
    await finishSession(b, "session-s");
  };

  test("lets the moved-to location take a session whose move was lost in a disposal", async () => {
    const client = await sourceClient();
    await loseMoveInDisposal(client);
    await runAtB();

    const spans = await flushed(client);
    expect(
      turnsOf(spans, "session-s").map((turn) => turn.metadata.messageID),
    ).toEqual(["session-s-user-1", "session-s-user-2"]);
    expect(named(spans, "opencode.generation")).toHaveLength(2);
    expect(client.debugSessionState("session-s").holder).toBe("/b");
  });

  test("lets the moved-to location take a lost move's session after the old location was re-created", async () => {
    const client = await sourceClient();
    await loseMoveInDisposal(client);
    // The evicted location comes back right away (spec E6).
    await startInstance(OPTIONS, A);
    await runAtB();

    const spans = await flushed(client);
    expect(
      turnsOf(spans, "session-s").map((turn) => turn.metadata.messageID),
    ).toEqual(["session-s-user-1", "session-s-user-2"]);
    expect(named(spans, "opencode.generation")).toHaveLength(2);
    expect(client.debugSessionState("session-s").holder).toBe("/b");
  });

  test("lets the recorded location take back a session an old location took while nobody held it", async () => {
    const client = await sourceClient();
    const a = await startReady(OPTIONS, A);
    const b = await startInstance(OPTIONS, B);
    userPrompt(a, "session-s", "session-s-user-1");
    await runGeneration(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-1",
    });
    // Only A reads the move: A lets go of the session, and nobody holds it.
    await a.emit(moved("session-s", "/b", 1));
    expect(client.debugSessionState("session-s").holder).toBeUndefined();

    // A late hook of A may take the unheld session.
    userPrompt(a, "session-s", "session-s-user-2");
    expect(client.debugSessionState("session-s").holder).toBe("/a");

    // B's hook at the recorded location takes it back; A's late events and
    // its disposal no longer end B's turn.
    userPrompt(b, "session-s", "session-s-user-3");
    expect(client.debugSessionState("session-s").holder).toBe("/b");
    await runGeneration(b, {
      sessionID: "session-s",
      messageID: "session-s-assistant-3",
    });
    await stepStarted(a, {
      sessionID: "session-s",
      messageID: "session-s-assistant-late",
    });
    await finishSession(a, "session-s");
    await a.dispose();
    // Turns that end in the same flush may be exported in any order.
    const turnIDs = async () =>
      turnsOf(await flushed(client), "session-s")
        .map((turn) => turn.metadata.messageID)
        .sort();
    expect(await turnIDs()).toEqual(["session-s-user-1", "session-s-user-2"]);

    await finishSession(b, "session-s");
    expect(await turnIDs()).toEqual([
      "session-s-user-1",
      "session-s-user-2",
      "session-s-user-3",
    ]);
  });
});
