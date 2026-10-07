# 0006. Packs are compiled into the binary in v1

Status: proposed

## Context
Gauntlet ships as one `bun build --compile` binary. Loading packs dynamically from disk would add a code-loading path that the coding agent could tamper with, and it complicates the binary.

## Decision
Packs are TypeScript modules in `packs/*` implementing a `Pack` interface: `detect`, a catalog of gates and rules, integrity detectors (ADR 0013), tamper-fixture instantiation for `selftest`, the runner-config globs to materialise from base (ADR 0003), dependency manifests, legacy baseline importers, and support files such as Gradle init scripts and WASM grammars. They are registered statically in `PackRegistryLive`. `use <pack>` selects from the compiled-in set.

## Consequences
- What runs is exactly what was released. The repo can't inject pack code.
- Third-party packs need a release of Gauntlet. External pack loading can be revisited after v1 together with a signing story.
