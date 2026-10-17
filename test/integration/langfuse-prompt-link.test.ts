import { createServer } from "node:http";
import type { Server } from "node:http";

import { trace } from "@opentelemetry/api";
import { Effect, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { PROMPT_LINKING } from "../../src/prompt-link.js";

// Every path that writes generation metadata must carry promptLink, otherwise
// the write at step end silently drops it.

const OtlpBodySchema = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(
        Schema.Struct({
          spans: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              attributes: Schema.Array(
                Schema.Struct({
                  key: Schema.String,
                  value: Schema.Struct({
                    stringValue: Schema.optional(Schema.String),
                    intValue: Schema.optional(
                      Schema.Union(Schema.Number, Schema.String),
                    ),
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

const REVIEWER_PROMPT = "You are the reviewer.\nCheck every change.\n";
const SYSTEM = [
  { type: "text", text: "You are the reviewer.\nCheck every change." },
];
const model = { id: "model-1", providerID: "provider-1" };
const tokens = {
  input: 1,
  output: 1,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

const exported: { name: string; attributes: Record<string, unknown> }[] = [];
let promptRequests = 0;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/api/public/v2/prompts") {
        promptRequests += 1;
        response.end(
          JSON.stringify({
            data: [{ name: "agents/reviewer", versions: [3] }],
            meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 },
          }),
        );
        return;
      }
      if (url.pathname.startsWith("/api/public/v2/prompts/")) {
        promptRequests += 1;
        response.end(
          JSON.stringify({
            name: "agents/reviewer",
            version: 3,
            type: "text",
            prompt: REVIEWER_PROMPT,
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
          attributes: Object.fromEntries(
            span.attributes.map(({ key, value }) => [
              key,
              value.stringValue ??
                (value.intValue === undefined
                  ? undefined
                  : Number(value.intValue)),
            ]),
          ),
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
  baseUrl = `http://127.0.0.1:${address.port.toString()}`;
});

afterAll(async () => {
  trace.disable();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("generation metadata write paths", () => {
  test("carry promptLink and the prompt attributes on every generation path", async () => {
    vi.stubGlobal("__PLUGIN_VERSION__", "test");
    const { createLangfuseClient } = await import("../../src/langfuse.js");
    const client = await Effect.runPromise(
      createLangfuseClient({
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        baseUrl,
        environment: "test",
      }),
    );
    client[PROMPT_LINKING].register({
      promptLinking: { agents: { reviewer: "agents/reviewer" } },
    });
    await vi.waitFor(() => {
      expect(promptRequests).toBe(2);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    const begin = (sessionID: string) => {
      client.traceUserPrompt({
        sessionID,
        messageID: `${sessionID}-user`,
        content: [{ type: "text", text: "Review" }],
      });
      client.setGenerationInputSnapshot(sessionID, {
        system: SYSTEM,
        messages: [],
        tools: [],
      });
    };
    const start = (sessionID: string) => {
      client.startActiveGenerationStep({
        sessionID,
        assistantMessageID: `${sessionID}-assistant`,
        agent: "reviewer",
        model,
        started: 1_000,
      });
    };
    const end = (sessionID: string) => {
      client.traceGeneration({
        sessionID,
        messageID: `${sessionID}-assistant`,
        parentID: `${sessionID}-user`,
        modelID: model.id,
        providerID: model.providerID,
        agent: "reviewer",
        mode: "reviewer",
        created: 1_000,
        completed: 2_000,
        cost: 0,
        tokens,
      });
    };

    // Step start that creates the span; the span ends without another write.
    begin("start-new");
    start("start-new");
    client.endActiveGenerationSteps("start-new");

    // Step start that updates a span already known by message ID.
    begin("start-update");
    start("start-update");
    start("start-update");
    client.endActiveGenerationSteps("start-update");

    // Step start that adopts a span a tool call opened before the step.
    begin("start-adopt");
    client.traceToolStart({
      sessionID: "start-adopt",
      callID: "call-1",
      tool: "read",
      args: {},
    });
    start("start-adopt");
    client.endActiveGenerationSteps("start-adopt");

    // Step end for an active step.
    begin("end-active");
    start("end-active");
    end("end-active");

    // Step end without an active step creates the span itself.
    begin("end-new");
    end("end-new");

    // Failed step.
    begin("failed");
    start("failed");
    client.traceFailedGenerationStep({
      id: "failed-event",
      sessionID: "failed",
      assistantMessageID: "failed-assistant",
      completed: 2_000,
      error: { message: "boom" },
    });

    await Effect.runPromise(client.forceFlush);

    const generations = exported.filter(
      (span) => span.name === "opencode.generation",
    );
    expect(generations).toHaveLength(6);
    for (const span of generations) {
      const metadata: unknown = JSON.parse(
        String(span.attributes["langfuse.observation.metadata"]),
      );
      expect(metadata).toMatchObject({
        promptLink: { name: "agents/reviewer", status: "matched", version: 3 },
      });
      expect(span.attributes["langfuse.observation.prompt.name"]).toBe(
        "agents/reviewer",
      );
      expect(span.attributes["langfuse.observation.prompt.version"]).toBe(3);
    }
    const others = exported.filter(
      (span) => span.name !== "opencode.generation",
    );
    for (const span of others) {
      expect(span.attributes["langfuse.observation.prompt.name"]).toBe(
        undefined,
      );
    }
  });
});
