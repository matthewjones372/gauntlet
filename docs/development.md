# Development

Back to the [README](../README.md).

## Architecture

Gauntlet is a single binary, written in TypeScript on [Bun](https://bun.sh) and
[Effect](https://effect.website), with every language pack compiled in.

```text
packages/
  dsl        policy language (Langium) → canonical, hashed policy IR
  ir         the IR schema
  core       policy source, workspace, gates, integrity, review decision, reports
  sarif      evidence, baseline and fingerprints
  syntax     shared tree-sitter helpers for the language packs
  connect    GitHub workflows, CODEOWNERS, Claude Code setup
  mcp        the MCP server
  author     the authoring agent
  templates  project templates for `gauntlet new`
  cli        the gauntlet command
packs/       jvm, typescript, python, go, rust, scala, clojure
```

Design decisions are recorded as ADRs in [docs/adr/](adr/), and the
roadmap is [PLAN.md](../PLAN.md).

## Development

```bash
bun install
```

```bash
bun run typecheck && bun test
```

The end-to-end tests run real projects from `examples/fixtures` with their real
tools. They're off by default locally:

```bash
GAUNTLET_E2E=1 bun test packs
```

Build the release binaries into `dist/`:

```bash
bun run build
```

To release, set the version in `packages/cli/src/version.ts` and push a
matching tag such as `v0.1.0`. The release workflow builds, tests and publishes
the binaries. A tag with a suffix, such as `v0.1.0-rc.3`, becomes a prerelease.

### Adding a language pack

Language support lives in `packs/<language>`, compiled into the binary (ADR
0006). A pack implements the `Pack` interface from `packages/core`: detection,
onboarding defaults, gates (build, lint, arch, coverage, mutation), a suite
runner that writes JUnit XML into Gauntlet's output directory, integrity
detectors, tamper fixtures for `selftest`, and dependency parsing. It's
registered in `packages/cli/src/packs.ts` and gets a real-tool end-to-end test
against a fixture in `examples/fixtures`. The Go and Rust packs are the
smallest complete examples, and [PLAN.md](../PLAN.md) lists the packs still to
build.
