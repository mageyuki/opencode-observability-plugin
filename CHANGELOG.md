# Changelog

This changelog covers the unofficial `@mageyuki/opencode-observability-plugin`
fork. For upstream changes see the
[upstream releases](https://github.com/langfuse/opencode-observability-plugin/releases).

## 0.5.2-mageyuki.4

Based on upstream `v0.5.2` (`24389efd13decfb72e103950526669addcb245e8`).

### Fixed

- In an OpenCode 2 server with several locations (directories or
  worktrees), the disposal of an idle location ended the open turns,
  generations and tools of sessions at the other locations and cleared the
  prompt version history and parent session links of every session. Turns
  were cut off early, evaluation tasks lost their `langfuse.release`, and
  child sessions that continued later became root traces. A disposal now
  ends and forgets only the sessions its plugin instance holds, and keeps
  their version history and parent links. A late hook from a location that
  a session moved away from is still traced but no longer takes the session
  from the instance that holds it; run events of an instance while another
  instance holds the session, and hooks and run events after a disposal,
  are ignored.

### Changed

- With `promptVersions`, a window that has no value determined inside it or
  before it (for example a session first seen after a restart) is stamped
  `agentsMdStatus=unavailable` instead of getting no prompt version
  attributes. This includes spans of a new session before its first
  generation and turns without a determined generation; no release is
  written for them, as before. A reset of the plugin's whole state makes the
  windows that start before it `unavailable`.
- Dependency ranges are the same as `0.5.2-mageyuki.3`.

## 0.5.2-mageyuki.3

Based on upstream `v0.5.2` (`24389efd13decfb72e103950526669addcb245e8`).

### Fixed

- A fresh `npm install` of `0.5.2-mageyuki.1` or `.2` resolved
  `@langfuse/otel@5.14.0`, whose peer range `>=0.202.0 <1.0.0` admits
  `@opentelemetry/exporter-trace-otlp-http@0.300.0` and
  `@opentelemetry/otlp-exporter-base@0.300.0` (OpenTelemetry JS 3.x, which
  needs `@opentelemetry/api >=1.10.0 <1.11.0`). The plugin keeps
  `@opentelemetry/api` at 1.9.x with the 2.x SDK packages, so loading failed
  with `SyntaxError: ... '@opentelemetry/api' does not provide an export named
'SeverityNumber'`. The package now declares both exporter packages as direct
  dependencies with the range `>=0.202.0 <0.300.0` (still inside the
  `@langfuse/otel` peer range), so installs resolve the OpenTelemetry 2.x
  compatible line (`0.221.0` in the lockfile). No source change.
- `0.5.2-mageyuki.2` is deprecated for this reason; use
  `0.5.2-mageyuki.3` or later.

## 0.5.2-mageyuki.2

Based on upstream `v0.5.2` (`24389efd13decfb72e103950526669addcb245e8`).

### Added

- Opt-in prompt version attribution for OpenCode 2 through the
  `promptVersions` plugin option. Generations, turns and every other span of
  the same session get the `AGENTS.md` version that was actually loaded
  (`langfuse.release`, for example `policy/AGENTS@51`) and the agent prompt
  version (`langfuse.version`, for example `agents/reviewer@12`), plus status
  metadata. See [Prompt Versions](./README.md#prompt-versions).
- The instruction prompt (for example `policy/AGENTS`) is indexed from its
  newest 50 versions, without model/variant constraints, so it stays usable
  past 200 versions. Agent prompts keep the existing rules.

### Changed

- No new span processor: the existing app-root processor stamps the other
  spans of a session. Without `promptVersions` options the spans are the same
  as `0.5.2-mageyuki.1` apart from `langfuse.plugin.version`.

## 0.5.2-mageyuki.1

Based on upstream `v0.5.2` (`24389efd13decfb72e103950526669addcb245e8`).

### Added

- Opt-in prompt linking for OpenCode 2 through the `promptLinking` plugin
  option. A generation whose system part equals a Langfuse prompt version gets
  `langfuse.observation.prompt.name` and `langfuse.observation.prompt.version`,
  and judged generations get `promptLink` metadata. See
  [Prompt Linking](./README.md#prompt-linking).

### Changed

- Published as `@mageyuki/opencode-observability-plugin`. Without
  `promptLinking` options the spans are the same as upstream `v0.5.2` apart
  from `langfuse.plugin.version`.
