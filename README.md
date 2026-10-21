# Langfuse OpenCode Plugin

> [!NOTE]
> This is `@mageyuki/opencode-observability-plugin`, an **unofficial fork** of
> [`@langfuse/opencode-observability-plugin`](https://github.com/langfuse/opencode-observability-plugin)
> that adds [prompt linking](#prompt-linking). It is not maintained or supported
> by Langfuse. Use `@mageyuki/opencode-observability-plugin@0.5.2-mageyuki.3` in
> place of `@langfuse/opencode-observability-plugin` in the examples below. See
> [FORK.md](./FORK.md) for the upstream base, the version scheme and the
> upstream status.

OpenCode plugin that sends OpenCode session telemetry to Langfuse. It traces user turns, assistant generations, tool calls, retries, reasoning output, compaction output, and failed generation steps.

## Quick Start

For OpenCode 2, enable the plugin in your configuration:

```json
{
  "plugins": ["@langfuse/opencode-observability-plugin@latest"]
}
```

For OpenCode 1, use the same package in your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@langfuse/opencode-observability-plugin@latest"]
}
```

Restart OpenCode after changing the config.

## Supported Versions

The default package entrypoint supports both OpenCode 1 and OpenCode 2. OpenCode
1 calls the plugin's `server()` implementation, while OpenCode 2 calls its
`setup()` implementation. The `/v1` and `/v2` entrypoints remain available for
direct imports.

Validated versions and entrypoints:

- OpenCode `2.0.4` and newer: `@langfuse/opencode-observability-plugin`
- OpenCode `1.18.29` and newer: `@langfuse/opencode-observability-plugin`

## Langfuse Credentials

Create `~/.config/opencode/opencode-langfuse.json` with your Langfuse credentials.

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://cloud.langfuse.com",
  "environment": "development",
  "userId": "your-user-id"
}
```

Only `publicKey` and `secretKey` are required. If `baseUrl` is not set, the plugin uses `https://cloud.langfuse.com`. If `environment` is not set, it uses `development`.

You can also set credentials with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"
export LANGFUSE_ENVIRONMENT="development"
export LANGFUSE_USER_ID="your-user-id"
```

If both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, the plugin uses environment variables instead of reading the config file. Optional values can be supplied either way.

## Prompt Linking

The plugin can link each OpenCode 2 generation to the [Langfuse prompt](https://langfuse.com/docs/prompt-management/get-started) version that holds the agent's prompt. It is off unless you configure it with plugin options:

```jsonc
{
  "plugins": [
    {
      "package": "@langfuse/opencode-observability-plugin@latest",
      "options": {
        "promptLinking": {
          // Prompt name for each agent; {agent} is replaced by the agent name.
          "agentPrompt": "agents/{agent}",
          // Optional explicit names, preferred over agentPrompt. null skips an agent.
          "agents": { "build": null },
        },
      },
    },
  ],
}
```

How it works:

- The plugin reads the prompt versions from the Prompt Management API (`/api/public/v2/prompts`) with the configured Langfuse credentials, so the key needs read access to prompts. Bodies are fetched with `resolve=false` and only their hashes are kept in memory.
- A generation is linked only when one whole system part equals a version's text after converting CRLF to LF and trimming trailing whitespace. A part that merely contains or extends a version's text is not linked. When the version's `config.model` (`<providerID>/<modelID>`) or `config.variant` is set, it must match the generation as well. A missing key leaves the version unconstrained, but a key that is present with a value that is not a non-empty string of at most 256 characters (for example `null`, a number, an object or `""`) makes that version unlinkable. Among versions with identical text, model and variant the newest is linked; any other ambiguity leaves the generation unlinked.
- Chat prompts and prompts that reference other prompts (`@@@langfusePrompt:`) are not linked. A prompt whose versions are all unlinkable reports `unavailable`.
- Linked generations get `langfuse.observation.prompt.name` and `langfuse.observation.prompt.version`. Every judged generation also gets `promptLink` metadata with `name`, `status` (`matched`, `no_match`, `ambiguous`, `not_registered` or `unavailable`) and, when matched, `version`.
- Tracing never waits for the prompt API. Versions are cached for 60 seconds; while the API is failing or slow, generations are left unlinked with status `unavailable`.
- Refreshes are driven by generations, not timers. A generation that uses a prompt name starts a background refresh once its cached versions are older than 45 seconds, so the cache stays current while that agent keeps generating. The first generation after more than 60 seconds without one for that name finds no usable cache: it starts with a provisional `unavailable` and is judged once more when its step ends. After a failed refresh the name stays `unavailable` until a refresh completes; retries back off from 10 seconds to 10 minutes.
- The `promptLink` written when a step starts is replaced when the step ends or fails. A generation that OpenCode closes without a step end (for example when the session finishes first) keeps the value from its start, which can be the provisional `unavailable`.
- Limits: at most 200 versions per prompt name, at most 1 MiB of prompt text per version (decoded UTF-8) and at most 1 MiB + 64 KiB per serialized API response, at most 2 concurrent requests with a 3 second timeout, and at most 64 prompt names per OpenCode process. A prompt over the version or text limit is recorded as `unavailable` in a completed snapshot: its version list is still refreshed like any other, but it is not retried with failure backoff and oversized bodies are not fetched again. Names beyond the 64th are reported as `unavailable` without any request, and one warning is logged.
- Options are fixed for the OpenCode process by the first plugin instance. If a re-created instance has different options, prompt linking stays off until OpenCode restarts.
- Invalid `promptLinking` options log one warning per OpenCode process and disable only prompt linking.
- OpenCode 1 does not expose the system prompt to plugins, so prompt linking applies to OpenCode 2 only.

## Prompt Versions

The plugin can record which version of a global instruction file (`AGENTS.md`) and which agent prompt version each OpenCode 2 generation actually ran with, so scores can be grouped by version with the Langfuse Metrics API (`traceRelease`, `traceVersion`). It is off unless you configure it:

```jsonc
{
  "plugins": [
    {
      "package": "@mageyuki/opencode-observability-plugin@0.5.2-mageyuki.3",
      "options": {
        "promptLinking": { "agentPrompt": "agents/{agent}" },
        "promptVersions": {
          "instructions": {
            // The instruction file as OpenCode prints it in "Instructions from: <path>".
            "path": "~/.config/opencode/AGENTS.md",
            // The Langfuse prompt that holds the versions of that file.
            "prompt": "policy/AGENTS",
          },
          "release": "instructions", // optional, the only accepted value
          "version": "agentPrompt", // optional, the only accepted value
        },
      },
    },
  ],
}
```

Options:

| Input                                                           | Handling                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptVersions` absent or `null`                               | Off; the spans are the same as without the feature.                                                                                                                                                                                                                                            |
| Not an object (`true`, a string, an array) or `{}`              | Invalid.                                                                                                                                                                                                                                                                                       |
| Keys other than `instructions` (required), `release`, `version` | Invalid.                                                                                                                                                                                                                                                                                       |
| `instructions`                                                  | An object with exactly `path` and `prompt`.                                                                                                                                                                                                                                                    |
| `path`                                                          | A non-empty absolute path, or one starting with `~/` (replaced by the home directory). `~` alone, `~user/`, relative paths and `$VAR` are invalid. Only normalized paths are accepted: a `.` or `..` segment, an empty segment (`//`) or a trailing `/` is invalid. Symlinks are not resolved. |
| `prompt`                                                        | 1 to 256 characters, without `{`, `}` or a newline. It must not be a name the same instance's `promptLinking` uses for agent prompts (an `agents` value, or a name the `agentPrompt` pattern matches).                                                                                         |
| `release`, `version`                                            | `"instructions"` and `"agentPrompt"` only (the defaults).                                                                                                                                                                                                                                      |

Invalid options log one warning (key names only) and disable only prompt versions; tracing and prompt linking continue. Options are fixed for the OpenCode process by the first plugin instance; a later instance with different (or missing, or invalid) `promptVersions` disables prompt versions until OpenCode restarts, without affecting prompt linking.

Values:

- `langfuse.release`: `policy/AGENTS@<N>` (the block equals version N), `policy/AGENTS#<sha12>` (an unregistered body, with the first 12 hex digits of its sha256), either followed by `+changed` when OpenCode reported that the file changed during the session, or `policy/AGENTS:mixed` when a turn or window holds more than one value. The prefix is the configured `prompt`.
- `langfuse.version`: `agents/<name>@<N>` when prompt linking matched, otherwise the agent name (for example `build`), or `mixed`.
- Metadata (`langfuse.observation.metadata.<key>`): `agentsMdVersion`, `agentsMdStatus` (`matched`, `no_match`, `absent`, `ambiguous`, `boundary_unknown`, `unavailable`, `mixed`), `agentsMdChanged`, `agentsMdSha12`, `agentPromptStatus` (`matched`, `not_registered`, `no_match`, `ambiguous`, `unavailable`, `disabled`, `mixed`), `otherInstructionCount` (other instruction blocks, counted only) and `promptVersionsSchema` (`1`). Every metadata value is written as a string (for example `"7"`, `"true"`), because the Langfuse SDK warns on export for non-string `langfuse.observation.metadata.*` attributes.
- Only names, version numbers, a 12-hex hash prefix, statuses, booleans and counts are written; never instruction text or paths. When the value is unknown, `langfuse.release` is left unset and only the status is recorded.

How it works and its limits:

- The block of the configured path is found in the system prompt by its `Instructions from: <path>` header and ends at the first blank line followed by another header or the `Today's date:` line (the OpenCode v2.1.1 format). Without that terminator the status is `boundary_unknown` and no release is written. Its text, with CRLF converted to LF and trailing whitespace trimmed, is hashed and compared with the newest 50 versions of the prompt; the newest version with exactly that text wins. Versions whose text contains a blank line followed by `Instructions from: ` or `Today's date: ` are not indexed.
- A change notice of OpenCode v2.1.1 for the configured path in the messages (`The instructions from <path> changed. Here's the diff:`, `… no longer apply.`, or `New instructions apply from:` followed by the path's block) marks the value `+changed`. If OpenCode changes these texts, changes are no longer detected and the session's starting version is recorded.
- A generation is stamped once, when its value is final (at step start, or at step end at the latest). A turn is stamped right before it ends from its generations. Every other span with a `session.id` (tools, events, evaluation tasks) is stamped when it starts from the values determined inside its window `[start, now]`, or, if there are none, the last value before it. A window that starts before the OpenCode process started, before history that had to be dropped, or while a generation of the session is still undetermined gets only `agentsMdStatus=unavailable`.
- The history is kept per session, so a subagent's generations do not count for its parent's spans. In the Metrics API a subagent turn's score is grouped by the trace root's (the parent's) values.
- These attributes are written after the Langfuse span processor, so a `LANGFUSE_RELEASE` environment variable does not override them; spans that get no release keep the environment value.
- The span processors are the same as without the feature. OpenCode 1 is not supported.

## Contributing

See the [contributing guide](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
