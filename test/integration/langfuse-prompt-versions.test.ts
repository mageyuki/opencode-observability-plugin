import { createServer } from "node:http";
import type { Server } from "node:http";

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

import type { LangfuseClient } from "../../src/langfuse.js";
import { PROMPT_LINKING } from "../../src/prompt-link.js";
import { promptVersionStamp } from "../../src/prompt-versions.js";

// Every generation and turn end path must write the prompt version
// attributes exactly once, before the span ends (spec D5 G1-G5, T1-T3). The
// single writer is spied on, so "once" is proven by the calls, not by the
// final exported attributes.

const OtlpBodySchema = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              spanId: Schema.String,
              attributes: Schema.Array(
                Schema.Struct({
                  key: Schema.String,
                  value: Schema.Struct({
                    stringValue: Schema.optional(Schema.String),
                  }),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

const P = "/h/.config/opencode/AGENTS.md";
const AGENTS_7 = "# Policy\nversion seven\n";
const AGENTS_8 = "# Policy\nversion eight\n";
const REVIEWER_PROMPT = "You are the reviewer.\nCheck every change.\n";
const PROVIDER_LINE = "p".repeat(57);
const model = { id: "model-1", providerID: "provider-1" };
const tokens = {
  input: 1,
  output: 1,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

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

const PROMPTS: Partial<Record<string, Partial<Record<number, string>>>> = {
  "policy/AGENTS": { 7: AGENTS_7, 8: AGENTS_8 },
  "agents/reviewer": { 3: REVIEWER_PROMPT },
  // Not prefetched: their snapshot is unavailable when a step starts.
  "agents/late-g5": { 1: REVIEWER_PROMPT },
  "agents/late-t1": { 1: REVIEWER_PROMPT },
};

type LogEntry = {
  kind: "write" | "end";
  spanName: string;
  spanId: string;
  attributes?: Record<string, string | number | boolean>;
};

const exported: { name: string; spanId: string; release?: string }[] = [];
const log: LogEntry[] = [];
let promptRequests = 0;
let server: Server;
let client: LangfuseClient;
const originalRelease = process.env.LANGFUSE_RELEASE;

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const spanId = (span: unknown) => {
  const spanContext = property(span, "spanContext");
  if (typeof spanContext !== "function") {
    throw new Error("Expected an OpenTelemetry span");
  }
  return String(property(Reflect.apply(spanContext, span, []), "spanId"));
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      const prefix = "/api/public/v2/prompts";
      if (url.pathname === prefix) {
        promptRequests += 1;
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
      if (url.pathname.startsWith(`${prefix}/`)) {
        promptRequests += 1;
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
        return;
      }
      const body = Schema.decodeUnknownSync(Schema.parseJson(OtlpBodySchema))(
        Buffer.concat(chunks).toString("utf8"),
      );
      for (const span of body.resourceSpans.flatMap((resourceSpan) =>
        resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
      )) {
        exported.push({
          name: span.name,
          spanId: span.spanId,
          release: span.attributes.find(
            (attribute) => attribute.key === "langfuse.release",
          )?.value.stringValue,
        });
      }
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP test server");
  }

  // Read by the Langfuse span processor when it is created.
  process.env.LANGFUSE_RELEASE = "env-release";
  vi.stubGlobal("__PLUGIN_VERSION__", "test");
  const { createLangfuseClient } = await import("../../src/langfuse.js");
  client = await Effect.runPromise(
    createLangfuseClient({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: `http://127.0.0.1:${address.port.toString()}`,
      environment: "test",
    }),
  );
  client[PROMPT_LINKING].register(
    {
      promptLinking: {
        agentPrompt: "agents/{agent}",
        agents: { reviewer: "agents/reviewer" },
      },
      promptVersions: { instructions: { path: P, prompt: "policy/AGENTS" } },
    },
    "/h",
  );
  // Two lists and three bodies.
  await vi.waitFor(() => {
    expect(promptRequests).toBe(5);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

  // Records span.end next to the writes, on the SDK span class.
  const probe = trace.getTracer("probe").startSpan("probe");
  const prototype: unknown = Object.getPrototypeOf(probe);
  probe.end();
  const originalEnd = property(prototype, "end");
  if (
    typeof originalEnd !== "function" ||
    typeof prototype !== "object" ||
    prototype === null
  ) {
    throw new Error("Expected the SDK span class");
  }
  Reflect.set(prototype, "end", function (this: unknown, ...args: unknown[]) {
    log.push({
      kind: "end",
      spanName: String(property(this, "name")),
      spanId: spanId(this),
    });
    const result: unknown = Reflect.apply(originalEnd, this, args);
    return result;
  });
});

beforeEach(() => {
  log.length = 0;
  vi.spyOn(promptVersionStamp, "write").mockImplementation(
    (span, attributes) => {
      log.push({
        kind: "write",
        spanName: String(property(span, "name")),
        spanId: spanId(span),
        attributes,
      });
      span.setAttributes(attributes);
    },
  );
});

afterEach(() => {
  client.endActiveGenerationSteps();
  client.endActiveTurnObservations();
  client.clearTraceState();
  vi.restoreAllMocks();
});

afterAll(async () => {
  trace.disable();
  if (originalRelease === undefined) {
    Reflect.deleteProperty(process.env, "LANGFUSE_RELEASE");
  } else {
    process.env.LANGFUSE_RELEASE = originalRelease;
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const prompt = (sessionID: string, messageID = `${sessionID}-user`) => {
  client.traceUserPrompt({
    sessionID,
    messageID,
    content: [{ type: "text", text: "Review" }],
  });
};
const snapshot = (
  sessionID: string,
  agentsBody = AGENTS_7,
  terminated = true,
) => {
  client.setGenerationInputSnapshot(sessionID, {
    system: system(agentsBody, terminated),
    messages: [],
    tools: [],
  });
};
const start = (
  sessionID: string,
  messageID = `${sessionID}-assistant`,
  agent = "reviewer",
) => {
  client.startActiveGenerationStep({
    sessionID,
    assistantMessageID: messageID,
    agent,
    model,
    started: Date.now(),
  });
};
const generation = (
  sessionID: string,
  messageID = `${sessionID}-assistant`,
  parentID = `${sessionID}-user`,
) => {
  client.traceGeneration({
    sessionID,
    messageID,
    parentID,
    modelID: model.id,
    providerID: model.providerID,
    agent: "reviewer",
    mode: "reviewer",
    created: Date.now(),
    completed: Date.now(),
    cost: 0,
    tokens,
  });
};

const writesFor = (spanName: string) =>
  log.filter((entry) => entry.kind === "write" && entry.spanName === spanName);

// Every span of the name was written exactly once, before it ended.
const expectStampedOnceBeforeEnd = (spanName: string, count: number) => {
  const ends = log.filter(
    (entry) => entry.kind === "end" && entry.spanName === spanName,
  );
  expect(ends).toHaveLength(count);
  for (const end of ends) {
    const writes = log.filter(
      (entry) => entry.kind === "write" && entry.spanId === end.spanId,
    );
    expect(writes).toHaveLength(1);
    expect(
      log.findIndex(
        (entry) => entry.kind === "write" && entry.spanId === end.spanId,
      ),
    ).toBeLessThan(log.indexOf(end));
  }
};

describe("prompt version end paths", () => {
  test("G1 success", () => {
    prompt("g1");
    snapshot("g1");
    start("g1");
    generation("g1");
    client.endActiveTurnObservations("g1");

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    expectStampedOnceBeforeEnd("opencode.turn", 1);
    expect(writesFor("opencode.generation")[0]?.attributes).toMatchObject({
      "langfuse.release": "policy/AGENTS@7",
      "langfuse.version": "agents/reviewer@3",
    });
  });

  test("G2 one-shot", () => {
    prompt("g2");
    snapshot("g2");
    generation("g2");
    client.endActiveTurnObservations("g2");

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    expectStampedOnceBeforeEnd("opencode.turn", 1);
  });

  test("G3 failed step", () => {
    prompt("g3");
    snapshot("g3");
    start("g3");
    client.traceFailedGenerationStep({
      id: "g3-failed",
      sessionID: "g3",
      assistantMessageID: "g3-assistant",
      completed: Date.now(),
      error: { message: "boom" },
    });
    client.endActiveTurnObservations("g3");

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    expectStampedOnceBeforeEnd("opencode.turn", 1);
  });

  test("G5 + T2 bulk end on execution end", () => {
    prompt("g5");
    snapshot("g5");
    start("g5");
    client.endActiveGenerationSteps("g5");
    client.endActiveTurnObservations("g5");

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    expectStampedOnceBeforeEnd("opencode.turn", 1);
  });

  test("G5 + T3 abort", () => {
    prompt("t3");
    snapshot("t3");
    start("t3");
    client.traceSessionError({
      sessionID: "t3",
      error: { name: "MessageAbortedError" },
    });

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    expectStampedOnceBeforeEnd("opencode.turn", 1);
  });

  test("G5 + T2 dispose", () => {
    for (const sessionID of ["d1", "d2"]) {
      prompt(sessionID);
      snapshot(sessionID);
      start(sessionID);
    }
    client.endActiveGenerationSteps();
    client.endActiveTurnObservations();

    expectStampedOnceBeforeEnd("opencode.generation", 2);
    expectStampedOnceBeforeEnd("opencode.turn", 2);
  });

  test("T1 next user message", () => {
    prompt("t1", "t1-user-1");
    snapshot("t1");
    start("t1");
    generation("t1", "t1-assistant", "t1-user-1");
    prompt("t1", "t1-user-2");

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    expectStampedOnceBeforeEnd("opencode.turn", 1);
    // The existing retention of ended turns is unchanged (base L591-598).
    const turns = property(
      property(client, "traceState"),
      "turnObservationsByMessageId",
    );
    expect(turns instanceof Map && turns.has("t1-user-1")).toBe(true);
  });

  test("G4 writes nothing", () => {
    prompt("g4");
    snapshot("g4");
    client.traceFailedGenerationStep({
      id: "g4-failed",
      sessionID: "g4",
      completed: Date.now(),
      error: { message: "boom" },
    });

    expect(writesFor("opencode.generation.failed")).toEqual([]);
    expect(
      log.some(
        (entry) =>
          entry.kind === "end" &&
          entry.spanName === "opencode.generation.failed",
      ),
    ).toBe(true);
  });

  test("idempotent across paths", () => {
    prompt("idem");
    snapshot("idem");
    start("idem");
    generation("idem");
    client.endActiveGenerationSteps("idem");
    client.traceSessionError({
      sessionID: "idem",
      error: { name: "MessageAbortedError" },
    });

    expect(writesFor("opencode.generation")).toHaveLength(1);
    expect(writesFor("opencode.turn")).toHaveLength(1);

    // T1 ends the first turn, which stays mapped by its message ID, so the
    // bulk end reaches it again.
    log.length = 0;
    prompt("idem2", "idem2-user-1");
    snapshot("idem2");
    generation("idem2", "idem2-assistant", "idem2-user-1");
    prompt("idem2", "idem2-user-2");
    client.endActiveTurnObservations();
    const turnWrites = writesFor("opencode.turn");
    expect(turnWrites).toHaveLength(2);
    expect(new Set(turnWrites.map((entry) => entry.spanId)).size).toBe(2);
  });

  test("G2 writes right after startSpan and survives LANGFUSE_RELEASE", async () => {
    exported.length = 0;
    prompt("env");
    snapshot("env");
    generation("env");
    client.endActiveTurnObservations("env");

    expectStampedOnceBeforeEnd("opencode.generation", 1);
    const write = writesFor("opencode.generation").at(0);
    await Effect.runPromise(client.forceFlush);
    await vi.waitFor(() => {
      expect(
        exported.find((span) => span.spanId === write?.spanId)?.release,
      ).toBe("policy/AGENTS@7");
    });
  });
});

describe("prompt version end re-determination", () => {
  // The agent prompt snapshot is not available when the step starts, so the
  // generation is not final then; it becomes available before the end path.
  const startPending = async (sessionID: string, agent: string) => {
    const before = promptRequests;
    start(sessionID, `${sessionID}-assistant`, agent);
    expect(writesFor("opencode.generation")).toEqual([]);
    await vi.waitFor(() => {
      expect(promptRequests).toBe(before + 2);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  };

  test("re-judges the agent prompt on the G5 bulk end", async () => {
    prompt("late-g5");
    snapshot("late-g5");
    await startPending("late-g5", "late-g5");
    client.endActiveGenerationSteps("late-g5");

    expect(writesFor("opencode.generation")[0]?.attributes).toMatchObject({
      "langfuse.version": "agents/late-g5@1",
      "langfuse.observation.metadata.agentPromptStatus": "matched",
    });
  });

  test("re-judges the agent prompt when T1 ends the turn", async () => {
    prompt("late-t1", "late-t1-user-1");
    snapshot("late-t1");
    await startPending("late-t1", "late-t1");
    prompt("late-t1", "late-t1-user-2");

    expect(writesFor("opencode.generation")[0]?.attributes).toMatchObject({
      "langfuse.version": "agents/late-t1@1",
    });
    expect(writesFor("opencode.turn")[0]?.attributes).toMatchObject({
      "langfuse.version": "agents/late-t1@1",
    });
  });
});

describe("prompt version turn state", () => {
  test("keeps O(1) turn state and releases it", () => {
    prompt("big");
    for (let index = 0; index < 10_000; index += 1) {
      snapshot("big", index % 2 === 0 ? AGENTS_7 : AGENTS_8);
      generation("big", `big-assistant-${index.toString()}`);
    }

    expect(client.debugPromptVersionState()).toMatchObject({
      turnSummaries: 1,
      maxDistinctReleases: 2,
    });
    client.endActiveTurnObservations("big");
    expect(client.debugPromptVersionState()).toMatchObject({
      turnSummaries: 0,
      maxDistinctReleases: 0,
    });
    const turnWrites = writesFor("opencode.turn");
    expect(turnWrites).toHaveLength(1);
    expect(turnWrites[0]?.attributes?.["langfuse.release"]).toBe(
      "policy/AGENTS:mixed",
    );
  });

  test("stamp once on transitions", () => {
    prompt("tr", "tr-user-1");
    snapshot("tr", AGENTS_7);
    generation("tr", "tr-assistant-1", "tr-user-1");
    prompt("tr", "tr-user-2");
    snapshot("tr", AGENTS_7, false);
    generation("tr", "tr-assistant-2", "tr-user-2");
    client.endActiveTurnObservations("tr");

    const generations = writesFor("opencode.generation");
    expect(generations).toHaveLength(2);
    expect(generations[1]?.attributes?.["langfuse.release"]).toBeUndefined();
    expect(
      generations[1]?.attributes?.[
        "langfuse.observation.metadata.agentsMdStatus"
      ],
    ).toBe("boundary_unknown");

    log.length = 0;
    prompt("mx");
    snapshot("mx", AGENTS_7);
    generation("mx", "mx-assistant-1");
    snapshot("mx", AGENTS_8);
    generation("mx", "mx-assistant-2");
    client.endActiveTurnObservations("mx");

    const turns = writesFor("opencode.turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.attributes?.["langfuse.release"]).toBe(
      "policy/AGENTS:mixed",
    );
  });
});
