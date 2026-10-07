# 0001. Use Effect 4

Status: proposed

## Context
The brief names `@effect/cli`, `@effect/ai` and `@effect/platform`. Those packages are on the Effect 3 line. Effect 4 (4.0.1) is now current. In v4 the CLI, AI, HTTP and process modules are part of `effect` itself, and only `@effect/platform-bun` and `@effect/ai-anthropic` are still separate packages. The two lines can't be mixed. The spike confirmed that v4 works inside a compiled Bun binary.

## Decision
Use Effect 4: `effect`, `effect/cli`, `effect/ai`, `effect/process`, `@effect/platform-bun` and `@effect/ai-anthropic`. Services are defined with `Context.Service`, which replaces `Context.Tag`.

## Consequences
- There are fewer packages and one version to pin. The ecosystem is aligned for the life of the project.
- `effect/cli` and `effect/ai` are marked `@stability unstable`. Exact versions will be pinned, and upgrades will be deliberate.
- Most examples online are still v3, so contributors need to know the renames.
