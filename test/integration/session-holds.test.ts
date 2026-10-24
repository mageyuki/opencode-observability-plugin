import { createServer } from "node:http";
import type { Server } from "node:http";

import { trace } from "@opentelemetry/api";
import { Effect, Schema } from "effect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import type { LangfuseClient } from "../../src/langfuse.js";
import { PROMPT_LINKING } from "../../src/prompt-link.js";
import { SESSION_HOLDS } from "../../src/session-holds.js";

// The shared client's table of which plugin instance holds a session, and
// the per-session cleanup it drives (spec D3-D5). A location disposal must
// end and forget only the sessions its instance holds.

const OtlpBodySchema = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({ name: Schema.String, spanId: Schema.String }),
          ),
        }),
      ),
    }),
  ),
});

const P = "/h/.config/opencode/AGENTS.md";
const AGENTS_7 = "# Policy\nversion seven\n";
const REVIEWER_PROMPT = "You are the reviewer.\nCheck every change.\n";
const PROMPTS: Partial<Record<string, Partial<Record<number, string>>>> = {
  "policy/AGENTS": { 7: AGENTS_7 },
  "agents/reviewer": { 3: REVIEWER_PROMPT },
};
const model = { id: "model-1", providerID: "provider-1" };
const tokens = {
  input: 1,
  output: 1,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

const exported: { name: string; spanId: string }[] = [];
let promptRequests = 0;
let server: Server;
let client: LangfuseClient;

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
      exported.push(
        ...body.resourceSpans.flatMap((resourceSpan) =>
          resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans),
        ),
      );
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
  // One list and one body for each of the two prompts.
  await vi.waitFor(() => {
    expect(promptRequests).toBe(4);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
});

beforeEach(async () => {
  await Effect.runPromise(client.forceFlush);
  exported.length = 0;
});

afterAll(async () => {
  trace.disable();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const exportedNames = async () => {
  await Effect.runPromise(client.forceFlush);
  return exported.map((span) => span.name);
};

// A turn with an ended generation, an active generation, an ended and an
// active tool, an event, a failed step and reasoning; every ID it uses is
// returned so the state can be counted independently of the client's index.
const busySession = (sessionID: string) => {
  const id = (suffix: string) => `${sessionID}-${suffix}`;
  const snapshot = () => {
    client.setGenerationInputSnapshot(sessionID, {
      system: [
        { type: "text", text: REVIEWER_PROMPT.trimEnd() },
        {
          type: "text",
          text: `catalog\n\nInstructions from: ${P}\n${AGENTS_7}\n\nToday's date: Wed Oct 21 2026`,
        },
      ],
      messages: [],
      tools: [],
    });
  };
  const start = (messageID: string) => {
    client.startActiveGenerationStep({
      sessionID,
      assistantMessageID: messageID,
      agent: "reviewer",
      model,
      started: Date.now(),
    });
  };

  client.traceUserPrompt({
    sessionID,
    messageID: id("user"),
    content: [{ type: "text", text: "Review" }],
  });
  snapshot();
  start(id("assistant-1"));
  client.rememberReasoning({
    reasoningID: id("reasoning"),
    sessionID,
    messageID: id("assistant-1"),
    timestamp: Date.now(),
    text: "Thinking",
  });
  for (const call of [id("call-1"), id("call-2")]) {
    client.rememberToolCall({
      callID: call,
      messageID: id("assistant-1"),
      sessionID,
      tool: "read",
      args: {},
    });
    client.traceToolStart({
      sessionID,
      messageID: id("assistant-1"),
      callID: call,
      tool: "read",
      args: {},
    });
  }
  client.traceToolEnd({
    sessionID,
    messageID: id("assistant-1"),
    callID: id("call-1"),
    tool: "read",
    args: {},
    title: "read",
    output: "done",
  });
  client.traceGeneration({
    sessionID,
    messageID: id("assistant-1"),
    parentID: id("user"),
    modelID: model.id,
    providerID: model.providerID,
    agent: "reviewer",
    mode: "reviewer",
    created: Date.now(),
    completed: Date.now(),
    cost: 0,
    tokens,
  });
  client.traceEvent({
    id: id("event"),
    sessionID,
    name: "opencode.generation.retry",
    timestamp: Date.now(),
  });
  snapshot();
  start(id("assistant-2"));
  client.traceFailedGenerationStep({
    id: id("failed"),
    sessionID,
    assistantMessageID: id("assistant-3"),
    completed: Date.now(),
    error: { message: "boom" },
  });

  return [
    "user",
    "assistant-1",
    "assistant-2",
    "assistant-3",
    "reasoning",
    "call-1",
    "call-2",
    "event",
    "failed",
  ].map(id);
};

describe("session holds", () => {
  test("only the holding instance ends a session, and a hook moves the hold", async () => {
    const holds = client[SESSION_HOLDS];
    const x = holds.open({ directory: "/x" });
    const y = holds.open({ directory: "/y" });

    // Nobody holds s: the event's instance takes it.
    expect(x.event("hold-s")).toBe(true);
    client.traceUserPrompt({
      sessionID: "hold-s",
      messageID: "hold-s-user",
      content: [{ type: "text", text: "Review" }],
    });
    y.hook("hold-s");
    expect(x.event("hold-s")).toBe(false);
    expect(client.debugSessionState("hold-s").holder).toBe("/y");

    x.release();
    expect(await exportedNames()).not.toContain("opencode.turn");
    expect(client.debugSessionState("hold-s").holder).toBe("/y");

    y.release();
    expect(await exportedNames()).toContain("opencode.turn");
    expect(client.debugSessionState("hold-s").holder).toBeUndefined();

    // A session deleted by an instance that does not hold it is forgotten.
    expect(y.event("hold-s2")).toBe(true);
    const ids = busySession("hold-s2");
    x.deleted("hold-s2");
    expect(client.debugSessionState("hold-s2", ids)).toMatchObject({
      entries: 0,
      holder: undefined,
    });
  });

  test("a release forgets its sessions but keeps their history, parent link and location", async () => {
    const holds = client[SESSION_HOLDS];
    const x = holds.open({ directory: "/x" });
    const y = holds.open({ directory: "/y" });

    client.rememberSessionParent({ sessionID: "s1", parentSessionID: "p" });
    x.moved("s1", { directory: "/x" }, 1);
    const s1 = busySession("s1");
    y.hook("s2");
    const s2 = busySession("s2");
    expect(client.debugSessionState("s1").holder).toBe("/x");
    const s2Before = client.debugSessionState("s2", s2);
    expect(client.debugSessionState("s1", s1).entries).toBeGreaterThan(0);
    expect(client.debugSessionState("s1").historyRuns).toBe(1);
    await exportedNames();
    exported.length = 0;

    x.release();

    expect(client.debugSessionState("s1", s1)).toEqual({
      entries: 0,
      historyRuns: 1,
      parent: "p",
      location: "/x",
      holder: undefined,
    });
    expect(client.debugSessionState("s2", s2)).toEqual(s2Before);
    // The release ended s1's open turn, generation and tool, and nothing of
    // s2.
    expect((await exportedNames()).sort()).toEqual([
      "opencode.generation",
      "opencode.turn",
      "read",
    ]);

    // Deleting the parent keeps the child's link to it.
    x.deleted("p");
    expect(client.debugSessionState("s1").parent).toBe("p");
    x.deleted("s1");
    expect(client.debugSessionState("s1", s1)).toEqual({
      entries: 0,
      historyRuns: 0,
      parent: undefined,
      location: undefined,
      holder: undefined,
    });

    y.release();
    expect(client.debugSessionState("s2", s2).entries).toBe(0);
  });

  test("a disposing instance at the destination of a move lets go of another location's hold", () => {
    const holds = client[SESSION_HOLDS];
    const x = holds.open({ directory: "/x" });
    const y = holds.open({ directory: "/y" });
    x.hook("closing-s");

    // y's cleanup started; its event loop still reads the move to /y.
    y.close();
    y.moved("closing-s", { directory: "/y" }, 1);

    expect(client.debugSessionState("closing-s")).toMatchObject({
      location: "/y",
      holder: undefined,
    });
    x.release();
  });

  test("keeps at most 2000 parent links and locations, dropping the oldest", () => {
    const x = client[SESSION_HOLDS].open({ directory: "/x" });
    for (let index = 0; index <= 2000; index += 1) {
      const sessionID = `cap-${index.toString()}`;
      client.rememberSessionParent({ sessionID, parentSessionID: "cap-p" });
      x.moved(sessionID, { directory: "/x" }, 1);
    }

    expect(client.debugSessionState("cap-0")).toMatchObject({
      parent: undefined,
      location: undefined,
    });
    for (const sessionID of ["cap-1", "cap-2000"]) {
      expect(client.debugSessionState(sessionID)).toMatchObject({
        parent: "cap-p",
        location: "/x",
      });
    }
    x.release();
  });
});
