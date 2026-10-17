# Changelog

This changelog covers the unofficial `@mageyuki/opencode-observability-plugin`
fork. For upstream changes see the
[upstream releases](https://github.com/langfuse/opencode-observability-plugin/releases).

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
