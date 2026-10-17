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

// Drives the built OpenCode 2 entrypoint against a local server that plays
// both the Langfuse OTLP collector and the Prompt Management API.

const OtlpValueSchema = Schema.Struct({
  stringValue: Schema.optional(Schema.String),
  boolValue: Schema.optional(Schema.Boolean),
  intValue: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});
const OtlpSpanSchema = Schema.Struct({
  name: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Array(
    Schema.Struct({ key: Schema.String, value: OtlpValueSchema }),
  ),
  status: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
  events: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
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

const NormalizedSpanSchema = Schema.Struct({
  name: Schema.String,
  parent: Schema.NullOr(Schema.String),
  attributes: Schema.Record({
    key: Schema.String,
    value: Schema.Union(Schema.String, Schema.Boolean, Schema.Number),
  }),
  status: Schema.NullOr(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
  events: Schema.Array(Schema.String),
});
const GoldenSchema = Schema.Struct({
  processors: Schema.Array(Schema.String),
  spans: Schema.Array(NormalizedSpanSchema),
});

type NormalizedSpan = typeof NormalizedSpanSchema.Type;

const PLUGIN_VERSION_PLACEHOLDER = "<plugin-version>";

const golden = Schema.decodeUnknownSync(Schema.parseJson(GoldenSchema))(
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
};

const otlpSpans: OtlpSpan[] = [];
const promptRequests: { url: string; authorization?: string }[] = [];
const heldPromptResponses: ServerResponse[] = [];
let promptHandler: (url: URL, response: ServerResponse) => void = (
  _url,
  response,
) => {
  response.writeHead(500).end();
};
let server: Server;
let plugin: (typeof import("../../src/v2.js"))["default"];
const cleanups: (() => Promise<void>)[] = [];

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

const startInstance = async (options?: unknown) => {
  const hooks = new Map<string, HookHandler>();
  const queue = createEventQueue();
  const registration = { dispose: () => Promise.resolve() };
  const context = Schema.decodeUnknownSync(SetupContextSchema)({
    app: { version: "2.0.4" },
    ...(options === undefined ? {} : { options }),
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

  return { hook, emit, dispose };
};

type Instance = Awaited<ReturnType<typeof startInstance>>;

// The registered prompt body ends with a newline; OpenCode trims it.
const REVIEWER_PROMPT = "You are the reviewer.\nCheck every change.\n";
const SYSTEM = [
  { type: "text", text: "You are the reviewer.\nCheck every change." },
  {
    type: "text",
    text: "Instructions from: /home/user/.config/opencode/AGENTS.md\n# Policy\n",
  },
];

const model = { id: "model-1", providerID: "provider-1" };

const contextInput = (text: string) => ({
  sessionID: "session-1",
  agent: "reviewer",
  model: { id: model.id, providerID: model.providerID },
  system: SYSTEM,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: {
    read: {
      description: "Read a file",
      input: { type: "object", properties: {} },
    },
  },
  options: {},
});

// One OpenCode 2 session: a generation with a tool call, a retry, a failed
// generation, then completion. Every stage goes through the shared client.
const scenario = {
  prompt: (instance: Instance) => {
    instance.hook("session.prompt", {
      sessionID: "session-1",
      messageID: "user-1",
      prompt: { text: "Review the diff" },
    });
    instance.hook("session.context", contextInput("Review the diff"));
  },
  startFirst: async (instance: Instance) => {
    await instance.emit({
      type: "session.step.started",
      id: "event-step-1",
      created: 1_000,
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        agent: "reviewer",
        model,
        snapshot: "snapshot-1",
      },
    });
  },
  finishFirst: async (instance: Instance) => {
    instance.hook("tool.execute.before", {
      id: "call-1",
      messageID: "assistant-1",
      sessionID: "session-1",
      tool: "read",
      input: { path: "README.md" },
    });
    instance.hook("tool.execute.after", {
      status: "completed",
      id: "call-1",
      messageID: "assistant-1",
      sessionID: "session-1",
      tool: "read",
      input: { path: "README.md" },
      result: { content: "readme" },
    });
    for (const [type, text] of [
      ["session.text.ended", "Looks"],
      ["session.text.ended", " good"],
      ["session.reasoning.ended", "Thinking"],
    ]) {
      await instance.emit({
        type,
        created: 1_500,
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          text,
        },
      });
    }
    await instance.emit({
      type: "session.step.ended",
      created: 2_000,
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        finish: "tool-calls",
        cost: 0.01,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 1,
          cache: { read: 2, write: 3 },
        },
      },
    });
  },
  rest: async (instance: Instance) => {
    instance.hook("session.context", contextInput("Continue"));
    await instance.emit({
      type: "session.retry.scheduled",
      id: "event-retry-1",
      created: 2_100,
      data: {
        sessionID: "session-1",
        attempt: 1,
        error: { message: "rate limited" },
      },
    });
    await instance.emit({
      type: "session.step.started",
      id: "event-step-2",
      created: 2_200,
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-2",
        agent: "reviewer",
        model,
        snapshot: "snapshot-2",
      },
    });
    await instance.emit({
      type: "session.step.failed",
      id: "event-failed-2",
      created: 2_500,
      data: {
        sessionID: "session-1",
        assistantMessageID: "assistant-2",
        error: { message: "provider failed" },
      },
    });
    await instance.emit({
      type: "session.execution.succeeded",
      id: "event-done",
      created: 3_000,
      data: { sessionID: "session-1" },
    });
  },
  run: async (instance: Instance) => {
    scenario.prompt(instance);
    await scenario.startFirst(instance);
    await scenario.finishFirst(instance);
    await scenario.rest(instance);
  },
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

const normalizeSpans = (spans: readonly OtlpSpan[]): NormalizedSpan[] => {
  const names = new Map(spans.map((span) => [span.spanId, span.name]));

  return spans.map((span) => ({
    name: span.name,
    parent:
      span.parentSpanId === undefined || span.parentSpanId === ""
        ? null
        : (names.get(span.parentSpanId) ?? "<external>"),
    attributes: Object.fromEntries(
      span.attributes.map(({ key, value }) => [
        key,
        key === "langfuse.plugin.version"
          ? PLUGIN_VERSION_PLACEHOLDER
          : attributeValue(value),
      ]),
    ),
    status:
      span.status === undefined ||
      (span.status.code === undefined && span.status.message === undefined)
        ? null
        : span.status,
    events: (span.events ?? []).map((event) => event.name),
  }));
};

const exportedSpans = async (count: number) => {
  await vi.waitFor(() => {
    expect(otlpSpans.length).toBeGreaterThanOrEqual(count);
  });
  return normalizeSpans(otlpSpans);
};

const processorNames = () => {
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
  const processors: unknown =
    typeof active === "object" && active !== null
      ? Reflect.get(active, "_spanProcessors")
      : undefined;
  if (!Array.isArray(processors)) {
    throw new Error("Expected a NodeTracerProvider with span processors");
  }
  return processors.map((processor: unknown) =>
    typeof processor === "object" && processor !== null
      ? processor.constructor.name
      : typeof processor,
  );
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/public/v2/prompts")) {
      promptRequests.push({
        url: `${url.pathname}${url.search}`,
        authorization: request.headers.authorization,
      });
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
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
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

  const builtPlugin: unknown = await import(
    new URL("../../dist/v2/index.js", import.meta.url).href
  );
  plugin = Schema.decodeUnknownSync(PluginModuleSchema)(builtPlugin).default;
});

beforeEach(() => {
  otlpSpans.length = 0;
  promptRequests.length = 0;
  promptHandler = (_url, response) => {
    response.writeHead(500).end();
  };
});

afterEach(async () => {
  for (const dispose of cleanups.splice(0)) {
    await dispose();
  }
  for (const response of heldPromptResponses.splice(0)) {
    response.destroy();
  }
  trace.disable();
  globalThis.langfuseOpencodeRuntimeState = undefined;
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
  })) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

const servePrompts = (url: URL, response: ServerResponse) => {
  const prefix = "/api/public/v2/prompts";
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (url.pathname === prefix) {
    send(
      200,
      url.searchParams.get("name") === "agents/reviewer"
        ? {
            data: [{ name: "agents/reviewer", versions: [1, 2] }],
            meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
          }
        : {
            data: [],
            meta: { page: 1, limit: 100, totalItems: 0, totalPages: 0 },
          },
    );
    return;
  }

  const version = Number(url.searchParams.get("version"));
  send(200, {
    name: "agents/reviewer",
    version,
    type: "text",
    prompt: version === 2 ? REVIEWER_PROMPT : "An older reviewer prompt.\n",
    config: {},
  });
};

const holdPrompts = (_url: URL, response: ServerResponse) => {
  heldPromptResponses.push(response);
};

// Waits until the plugin fetched the list and both versions, then gives it a
// moment to index them.
const promptsFetched = async () => {
  await vi.waitFor(() => {
    expect(promptRequests.length).toBeGreaterThanOrEqual(3);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
};

const PROMPT_ATTRIBUTES = new Set([
  "langfuse.observation.prompt.name",
  "langfuse.observation.prompt.version",
]);

// Splits the prompt link out of an exported span so the rest can be compared
// with the v0.5.2 golden span byte for byte.
const splitPromptLink = (span: NormalizedSpan) => {
  const entries = Object.entries(span.attributes);
  const attributes = Object.fromEntries(
    entries.filter(([key]) => !PROMPT_ATTRIBUTES.has(key)),
  );
  const prompt = Object.fromEntries(
    entries.filter(([key]) => PROMPT_ATTRIBUTES.has(key)),
  );
  const metadata = attributes["langfuse.observation.metadata"];
  let promptLink: unknown;
  if (typeof metadata === "string") {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed === "object" && parsed !== null) {
      promptLink = Reflect.get(parsed, "promptLink");
      Reflect.deleteProperty(parsed, "promptLink");
      attributes["langfuse.observation.metadata"] = JSON.stringify(parsed);
    }
  }

  return { span: { ...span, attributes }, prompt, promptLink };
};

const expectGoldenWithPromptLink = (
  spans: readonly NormalizedSpan[],
  promptLink: { name: string; status: string; version?: number } | undefined,
) => {
  expect(spans.map((span) => span.name)).toEqual(
    golden.spans.map((span) => span.name),
  );
  spans.forEach((actual, index) => {
    const split = splitPromptLink(actual);
    expect(split.span).toEqual(golden.spans[index]);

    const isGeneration = actual.name === "opencode.generation";
    expect(split.promptLink).toEqual(isGeneration ? promptLink : undefined);
    expect(split.prompt).toEqual(
      isGeneration && promptLink?.status === "matched"
        ? {
            "langfuse.observation.prompt.name": promptLink.name,
            "langfuse.observation.prompt.version": promptLink.version,
          }
        : {},
    );
  });
};

const matched = { name: "agents/reviewer", status: "matched", version: 2 };

describe("OpenCode 2 prompt linking", { concurrent: false }, () => {
  test("exports the same spans as v0.5.2 when promptLinking is not configured", async () => {
    const instance = await startInstance({ unrelated: true });
    await scenario.run(instance);

    expect(await exportedSpans(golden.spans.length)).toEqual(golden.spans);
    expect(processorNames()).toEqual(golden.processors);
    expect(promptRequests).toEqual([]);
  });

  test("adds only the prompt attributes and promptLink to generations that match", async () => {
    promptHandler = servePrompts;
    const instance = await startInstance({
      promptLinking: { agents: { reviewer: "agents/reviewer" } },
    });
    await promptsFetched();
    await scenario.run(instance);

    expectGoldenWithPromptLink(
      await exportedSpans(golden.spans.length),
      matched,
    );
    expect(processorNames()).toEqual(golden.processors);
    expect(promptRequests.map((request) => request.url)).toEqual([
      "/api/public/v2/prompts?name=agents%2Freviewer&page=1&limit=100",
      "/api/public/v2/prompts/agents%2Freviewer?version=1&resolve=false",
      "/api/public/v2/prompts/agents%2Freviewer?version=2&resolve=false",
    ]);
  });

  test("links at step end when the snapshot completes after the step started", async () => {
    const held: ServerResponse[] = [];
    promptHandler = (url, response) => {
      if (url.pathname === "/api/public/v2/prompts") {
        held.push(response);
        return;
      }
      servePrompts(url, response);
    };
    const instance = await startInstance({
      promptLinking: { agentPrompt: "agents/{agent}" },
    });

    scenario.prompt(instance);
    await scenario.startFirst(instance);
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    promptHandler = servePrompts;
    const list = new URL(
      "http://127.0.0.1/api/public/v2/prompts?name=agents/reviewer",
    );
    for (const response of held) {
      servePrompts(list, response);
    }
    await promptsFetched();
    await scenario.finishFirst(instance);
    await scenario.rest(instance);

    expectGoldenWithPromptLink(
      await exportedSpans(golden.spans.length),
      matched,
    );
  });

  test("ends and exports every span while the prompt API never answers", async () => {
    promptHandler = holdPrompts;
    const instance = await startInstance({
      promptLinking: { agentPrompt: "agents/{agent}" },
    });
    await scenario.run(instance);

    expectGoldenWithPromptLink(await exportedSpans(golden.spans.length), {
      name: "agents/reviewer",
      status: "unavailable",
    });
    expect(heldPromptResponses.length).toBeGreaterThan(0);
  });

  test("ends and exports every span when the prompt API fails", async () => {
    const instance = await startInstance({
      promptLinking: { agentPrompt: "agents/{agent}" },
    });
    await scenario.run(instance);

    expectGoldenWithPromptLink(await exportedSpans(golden.spans.length), {
      name: "agents/reviewer",
      status: "unavailable",
    });
    expect(promptRequests.length).toBeGreaterThan(0);
  });

  test("warns once and keeps tracing unchanged for invalid options", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    promptHandler = servePrompts;
    const instance = await startInstance({
      promptLinking: { agentPrompt: "agents/{agent}", secondary: {} },
    });
    await scenario.run(instance);

    expect(await exportedSpans(golden.spans.length)).toEqual(golden.spans);
    expect(promptRequests).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("keeps linking when a re-created instance has the same options", async () => {
    promptHandler = servePrompts;
    const options = { promptLinking: { agentPrompt: "agents/{agent}" } };
    const first = await startInstance(options);
    await first.dispose();
    const second = await startInstance(options);

    scenario.prompt(second);
    await scenario.startFirst(second);
    await promptsFetched();
    await scenario.finishFirst(second);
    await scenario.rest(second);

    const spans = await exportedSpans(golden.spans.length);
    const generations = spans
      .filter((span) => span.name === "opencode.generation")
      .map((span) => splitPromptLink(span).promptLink);
    expect(generations).toEqual([matched, matched]);
  });

  test("disables linking for the process when a later instance has different options", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    promptHandler = servePrompts;
    const first = await startInstance({
      promptLinking: { agentPrompt: "agents/{agent}" },
    });
    const second = await startInstance({});
    await scenario.run(second);
    await first.dispose();

    expect(await exportedSpans(golden.spans.length)).toEqual(golden.spans);
    expect(promptRequests).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("does not link through a shared client built without the fork marker", async () => {
    // Stands in for a client that the upstream build created first: no plugin
    // instance has registered options on it and it carries no marker.
    vi.stubGlobal("__PLUGIN_VERSION__", "upstream");
    const { createLangfuseRuntime } = await import("../../src/runtime.js");
    const client = await Effect.runPromise(
      createLangfuseRuntime({ opencodeVersion: "2.0.4" }),
    );
    Reflect.deleteProperty(
      client,
      Symbol.for("langfuse.opencode.promptLinking.v1"),
    );
    promptHandler = servePrompts;

    const instance = await startInstance({
      promptLinking: { agents: { reviewer: "agents/reviewer" } },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    await scenario.run(instance);

    expect(await exportedSpans(golden.spans.length)).toEqual(golden.spans);
    expect(promptRequests).toEqual([]);
  });
});
