# Fork notes

`@mageyuki/opencode-observability-plugin` is an unofficial fork of
[`@langfuse/opencode-observability-plugin`](https://github.com/langfuse/opencode-observability-plugin).
It is not maintained or supported by Langfuse. The upstream MIT license and
copyright notice in [LICENSE](./LICENSE) apply unchanged.

## Upstream base

- Upstream tag: `v0.5.2`
- Upstream commit: `24389efd13decfb72e103950526669addcb245e8`
- The lockfile is the upstream `v0.5.2` lockfile; build with
  `pnpm install --frozen-lockfile`.

## Changes from upstream

The fork keeps separate change sets on top of the upstream base:

1. **Prompt linking** (feature). Opt-in linking of OpenCode 2 generations to
   Langfuse Prompt Management versions through the `promptLinking` plugin
   option; see [Prompt Linking](./README.md#prompt-linking). It touches
   `src/prompt-link.ts`, `src/langfuse.ts`, `src/v2.ts`, the README section and
   the tests under `test/integration/`. This change set is kept free of fork
   identity so it can be ported to upstream on its own. The marker symbol that
   detects a shared client created by another build
   (`Symbol.for("langfuse.opencode.promptLinking.v1")`) exists only because the
   fork and upstream can share one process; an upstream port can drop it.
2. **Prompt versions** (feature, `0.5.2-mageyuki.2`). Opt-in attribution of
   the loaded `AGENTS.md` version and agent prompt version to
   `langfuse.release` / `langfuse.version` through the `promptVersions` plugin
   option; see [Prompt Versions](./README.md#prompt-versions). It adds
   `src/prompt-versions.ts` (option parsing, instruction scan, values and the
   single attribute writer) and `src/prompt-version-history.ts` (per-session
   history), adds the instruction prompt lookup and its owner rule to
   `src/prompt-link.ts`, wires the end paths and the existing app-root
   processor in `src/langfuse.ts`, and adds the README section and tests under
   `test/integration/`. It builds on the prompt linking change set and is not
   proposed upstream yet (the upstream proposal is tracked in
   `mageyuki/opencode-config#202`).
3. **Package identity**. Package name, version, description and repository
   links, this file, [CHANGELOG.md](./CHANGELOG.md), the README notice and the
   package name used by the tests to import the built package.

Without `promptLinking` and `promptVersions` options the plugin sends the same
spans as upstream `v0.5.2`; only the `langfuse.plugin.version` attribute
differs. The plugin id
(`langfuse.observability`), the tracer scope (`opencode-langfuse-plugin`), the
entrypoints (`.`, `./v1`, `./v2`) and the span processors are unchanged.

## Operational limits of prompt linking

These are accepted for this release; the README section
[Prompt Linking](./README.md#prompt-linking) is the user-facing description.

- **Demand-driven refresh.** No timers keep the cache warm. A generation that
  uses a prompt name refreshes it in the background once the cache is older
  than 45 seconds. After more than 60 seconds without a generation for that
  name, the next generation starts with a provisional `unavailable` and is
  judged once more at step end.
- **Provisional metadata.** The `promptLink` written at step start is replaced
  at step end or failure. A generation span closed without a step end (the
  plugin's `endActiveGenerationSteps`, for example when the session finishes
  first) keeps the start value, which can be `unavailable`.
- **Size limits.** At most 1 MiB of decoded prompt text (UTF-8 bytes) per
  version and at most 1 MiB + 64 KiB per serialized API response; at most 200
  versions per name. A prompt over these limits is recorded as `unavailable` in
  a completed snapshot, not treated as a failure, so it is not retried with
  backoff.
- **Bounds on retained state.** Only hashes of prompt text are kept. A
  `config.model` or `config.variant` that is present but not a non-empty string
  of at most 256 characters makes that version unlinkable instead of
  unconstrained. At most 64 prompt names are tracked per process, without
  eviction; later names report `unavailable` without requests and log one
  warning.
- **Warnings.** Invalid `promptLinking` options warn once per process. Fetch
  problems warn once per name and state change with an HTTP status or
  `transport failure` only.

## Version scheme

Versions are `<upstream version>-mageyuki.<N>`, starting at `N = 1` for each
upstream base (for example `0.5.2-mageyuki.1`). The plugin writes its package
version to `langfuse.plugin.version` on every span, so this keeps fork traces
distinguishable from upstream ones without claiming a future upstream version
number.

These are prerelease versions: publish them with an explicit dist-tag, for
example `npm publish <tarball> --access public --tag latest`. The release
workflow in `.github/workflows/` belongs to the upstream package and is not used
for fork releases.

## Following upstream

The fork does not follow upstream automatically. A newer upstream release is
adopted only after its output changes have been checked against the consumers
of these traces; the feature change set is then rebased onto that upstream tag
and released as `<upstream version>-mageyuki.1`.

## Upstream status

- Proposal: [langfuse discussion #18983](https://github.com/orgs/langfuse/discussions/18983).
- Upstream pull request: not opened yet.

If upstream ships an equivalent feature, consumers should move back to
`@langfuse/opencode-observability-plugin` and this fork stops publishing.
Published fork versions stay as they are.
