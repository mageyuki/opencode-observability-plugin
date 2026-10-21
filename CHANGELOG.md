# Changelog

This changelog covers the unofficial `@mageyuki/opencode-observability-plugin`
fork. For upstream changes see the
[upstream releases](https://github.com/langfuse/opencode-observability-plugin/releases).

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
