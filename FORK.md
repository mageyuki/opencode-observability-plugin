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

The fork keeps two separate change sets on top of the upstream base:

1. **Prompt linking** (feature). Opt-in linking of OpenCode 2 generations to
   Langfuse Prompt Management versions through the `promptLinking` plugin
   option; see [Prompt Linking](./README.md#prompt-linking). It touches
   `src/prompt-link.ts`, `src/langfuse.ts`, `src/v2.ts`, the README section and
   the tests under `test/integration/`. This change set is kept free of fork
   identity so it can be ported to upstream on its own. The marker symbol that
   detects a shared client created by another build
   (`Symbol.for("langfuse.opencode.promptLinking.v1")`) exists only because the
   fork and upstream can share one process; an upstream port can drop it.
2. **Package identity**. Package name, version, description and repository
   links, this file, [CHANGELOG.md](./CHANGELOG.md), the README notice and the
   package name used by the tests to import the built package.

Without `promptLinking` options the plugin sends the same spans as upstream
`v0.5.2`; only the `langfuse.plugin.version` attribute differs. The plugin id
(`langfuse.observability`), the tracer scope (`opencode-langfuse-plugin`), the
entrypoints (`.`, `./v1`, `./v2`) and the span processors are unchanged.

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
