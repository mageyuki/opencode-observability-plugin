import type { Plugin } from "@opencode/plugin";
import { Effect } from "effect";

import type { ToolDefinition } from "./langfuse.js";
import { PROMPT_LINKING } from "./prompt-link.js";
import { createLangfuseRuntime } from "./runtime.js";
import { openSessionHolds } from "./session-holds.js";

// The events of a run that this plugin applies; they come many times per
// session and change its state (spec D3 R3).
const RUN_EVENTS: ReadonlySet<string> = new Set([
  "session.step.started",
  "session.text.ended",
  "session.reasoning.ended",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled",
  "session.execution.failed",
  "session.execution.succeeded",
  "session.execution.interrupted",
]);

const LangfusePlugin = {
  id: "langfuse.observability",
  async setup(ctx) {
    const disableTracing = (error: { readonly message: string }) =>
      Effect.sync(() => {
        console.warn(`[Langfuse tracing disabled] ${error.message}`);
      }).pipe(Effect.as(undefined));

    const langfuse = await Effect.runPromise(
      createLangfuseRuntime({ opencodeVersion: ctx.app.version }).pipe(
        Effect.catchTag("MissingLangfuseCredentials", disableTracing),
      ),
    );
    if (!langfuse) {
      return;
    }

    // Only a client built by this package carries the marker; a client that
    // another build already shares in this process is used without linking.
    const promptLinking: unknown = Reflect.get(langfuse, PROMPT_LINKING);
    const options: unknown = ctx.options;
    if (
      typeof promptLinking === "object" &&
      promptLinking !== null &&
      "register" in promptLinking &&
      typeof promptLinking.register === "function"
    ) {
      Reflect.apply(promptLinking.register, promptLinking, [options]);
    }

    // The sessions this instance holds in the shared client (spec D3). The
    // context's type requires a location; it is read loosely because an
    // older OpenCode or a test context may not have one.
    const holds = openSessionHolds(langfuse, Reflect.get(ctx, "location"));
    // Set first thing on disposal: OpenCode may still call a hook it took
    // before the hook was disposed, and the event loop may still deliver an
    // event. Hooks and run events do nothing afterwards; the one-time
    // session facts are still recorded while the loop drains (spec D3 R1,
    // rev5).
    const instance = { disposed: false };
    // A hook writes its content whoever holds the session, then moves the
    // hold here if the session is at this location (R2).
    const hook =
      <Input extends { sessionID: string }>(handle: (input: Input) => void) =>
      (input: Input) => {
        if (instance.disposed) {
          return;
        }
        handle(input);
        holds?.hook(input.sessionID);
      };
    const abort = new AbortController();
    const registrations: { dispose: () => Promise<void> }[] = [];
    const userMessageIDs = new Map<string, string>();
    const generationDetails = new Map<
      string,
      {
        sessionID: string;
        agent: string;
        model: { id: string; providerID: string; variant?: string };
        started: number;
        text: string[];
        reasoning: string[];
        toolCalls: Map<string, { id: string; name: string; arguments: string }>;
      }
    >();

    registrations.push(
      await ctx.session.hook(
        "prompt",
        hook((input) => {
          userMessageIDs.set(input.sessionID, input.messageID);
          langfuse.traceUserPrompt({
            sessionID: input.sessionID,
            messageID: input.messageID,
            content: [
              { type: "text", text: input.prompt.text },
              ...(input.prompt.files ?? []).map((file) => ({
                type: "file",
                filename: file.name,
                url: file.uri,
              })),
              ...(input.prompt.agents ?? []).map((agent) => ({
                type: "agent",
                name: agent.name,
              })),
            ],
          });
        }),
      ),
    );

    registrations.push(
      await ctx.session.hook(
        "context",
        hook((input) => {
          const tools: ToolDefinition[] = Object.entries(input.tools).map(
            ([name, tool]) => ({
              name,
              description: tool.description,
              parameters: tool.input,
            }),
          );
          langfuse.setGenerationInputSnapshot(input.sessionID, {
            system: input.system,
            messages: input.messages,
            tools,
          });
        }),
      ),
    );

    registrations.push(
      await ctx.tool.hook(
        "execute.before",
        hook((input) => {
          generationDetails.get(input.messageID)?.toolCalls.set(input.id, {
            id: input.id,
            name: input.tool,
            arguments: JSON.stringify(input.input),
          });
          langfuse.rememberToolCall({
            callID: input.id,
            messageID: input.messageID,
            sessionID: input.sessionID,
            tool: input.tool,
            args:
              typeof input.input === "object" && input.input !== null
                ? { ...input.input }
                : {},
          });
          langfuse.traceToolStart({
            sessionID: input.sessionID,
            messageID: input.messageID,
            callID: input.id,
            tool: input.tool,
            args: input.input,
          });
        }),
      ),
    );

    registrations.push(
      await ctx.tool.hook(
        "execute.after",
        hook((input) => {
          if (input.status === "error") {
            langfuse.traceToolError({
              sessionID: input.sessionID,
              messageID: input.messageID,
              callID: input.id,
              tool: input.tool,
              args: input.input,
              error: input.error.message,
              completed: Date.now(),
            });
            return;
          }

          const content = input.result.content;
          const output =
            typeof content === "string"
              ? content
              : (content ?? [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n\n");
          langfuse.traceToolEnd({
            sessionID: input.sessionID,
            messageID: input.messageID,
            callID: input.id,
            tool: input.tool,
            args: input.input,
            title: input.tool,
            output,
          });
        }),
      ),
    );

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: abort.signal,
        })) {
          // Facts that are told once are recorded whoever holds the session,
          // also after the disposal started; they do not end or change any
          // observation (spec D3 F, R4).
          if (event.type === "session.created") {
            langfuse.rememberSessionParent({
              sessionID: event.data.sessionID,
              parentSessionID: event.data.parentID,
            });
            continue;
          }

          if (event.type === "session.moved") {
            // Moves of a session are ordered by their durable sequence; read
            // loosely so that an event without one cannot end this loop.
            const durable: unknown = Reflect.get(event, "durable");
            const seq: unknown =
              typeof durable === "object" && durable !== null
                ? Reflect.get(durable, "seq")
                : undefined;
            holds?.moved(
              event.data.sessionID,
              Reflect.get(event.data, "location"),
              typeof seq === "number" ? seq : event.created,
            );
            continue;
          }

          if (event.type === "session.deleted") {
            if (holds === undefined) {
              langfuse.clearSessionTraceState(event.data.sessionID);
            } else {
              holds.deleted(event.data.sessionID);
            }
            continue;
          }

          // Any other event changes the session's state only on the instance
          // that holds it; a late event of an instance the session left is
          // dropped (R3).
          if (
            instance.disposed ||
            !RUN_EVENTS.has(event.type) ||
            ("sessionID" in event.data &&
              typeof event.data.sessionID === "string" &&
              holds?.event(event.data.sessionID) === false)
          ) {
            continue;
          }

          if (event.type === "session.step.started") {
            generationDetails.set(event.data.assistantMessageID, {
              sessionID: event.data.sessionID,
              agent: event.data.agent,
              model: event.data.model,
              started: event.created,
              text: [],
              reasoning: [],
              toolCalls: new Map(),
            });
            langfuse.startActiveGenerationStep({
              sessionID: event.data.sessionID,
              assistantMessageID: event.data.assistantMessageID,
              agent: event.data.agent,
              model: event.data.model,
              started: event.created,
              snapshot: event.data.snapshot,
            });
          }

          if (event.type === "session.text.ended") {
            generationDetails
              .get(event.data.assistantMessageID)
              ?.text.push(event.data.text);
          }

          if (event.type === "session.reasoning.ended") {
            generationDetails
              .get(event.data.assistantMessageID)
              ?.reasoning.push(event.data.text);
          }

          if (event.type === "session.step.ended") {
            const details = generationDetails.get(
              event.data.assistantMessageID,
            );
            if (!details) {
              continue;
            }

            langfuse.traceGeneration({
              sessionID: event.data.sessionID,
              messageID: event.data.assistantMessageID,
              parentID: userMessageIDs.get(event.data.sessionID) ?? "",
              modelID: details.model.id,
              providerID: details.model.providerID,
              agent: details.agent,
              mode: details.agent,
              created: details.started,
              completed: event.created,
              finish: event.data.finish,
              cost: event.data.cost,
              tokens: event.data.tokens,
              output: [
                {
                  role: "assistant",
                  content: details.text.join(""),
                  ...(details.reasoning.length > 0
                    ? {
                        thinking: details.reasoning.map((content) => ({
                          type: "thinking",
                          content,
                        })),
                      }
                    : {}),
                  ...(details.toolCalls.size > 0
                    ? { tool_calls: Array.from(details.toolCalls.values()) }
                    : {}),
                },
              ],
            });
            generationDetails.delete(event.data.assistantMessageID);
          }

          if (event.type === "session.step.failed") {
            langfuse.traceFailedGenerationStep({
              id: event.id,
              sessionID: event.data.sessionID,
              assistantMessageID: event.data.assistantMessageID,
              completed: event.created,
              error: event.data.error,
            });
            generationDetails.delete(event.data.assistantMessageID);
          }

          if (event.type === "session.retry.scheduled") {
            langfuse.traceEvent({
              id: event.id,
              sessionID: event.data.sessionID,
              name: "opencode.generation.retry",
              timestamp: event.created,
              output: event.data.error,
              metadata: { attempt: event.data.attempt },
            });
          }

          if (event.type === "session.execution.failed") {
            langfuse.traceSessionError({
              sessionID: event.data.sessionID,
              error: {
                name: event.data.error.type,
                message: event.data.error.message,
              },
            });
            for (const [messageID, details] of generationDetails) {
              if (details.sessionID === event.data.sessionID) {
                generationDetails.delete(messageID);
              }
            }
            await Effect.runPromise(langfuse.forceFlush);
          }

          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.interrupted"
          ) {
            langfuse.endActiveToolObservations(event.data.sessionID);
            langfuse.endActiveGenerationSteps(event.data.sessionID);
            langfuse.endActiveTurnObservations(event.data.sessionID);
            for (const [messageID, details] of generationDetails) {
              if (details.sessionID === event.data.sessionID) {
                generationDetails.delete(messageID);
              }
            }
            await Effect.runPromise(langfuse.forceFlush);
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error(`Langfuse event subscription failed: ${String(error)}`);
        }
      }
    })();

    return async () => {
      instance.disposed = true;
      holds?.close();
      abort.abort();
      await Promise.all(
        registrations.map((registration) => registration.dispose()),
      );
      await events;
      // Ends and forgets only the sessions this instance holds: the client is
      // shared with the instances of other locations (spec D4). A client
      // without holds is only flushed (D7).
      holds?.release();
      // The tracer provider is process-wide and cannot be registered twice,
      // so an instance disposal must not tear it down (see runtime.ts).
      await Effect.runPromise(langfuse.forceFlush);
    };
  },
} satisfies Plugin.Plugin;

export default LangfusePlugin;
