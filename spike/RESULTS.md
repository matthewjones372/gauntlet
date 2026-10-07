# Spike: compiled-binary feasibility

Date: 2026-10-07. Bun 1.4.2 on macOS arm64.

## Question

Do Langium, `@effect/ai` with the Anthropic provider, the official MCP TypeScript SDK and the Effect runtime all work inside a `bun build --compile` binary on macOS arm64, macOS x64 and Linux x64?

## Answer

Yes. Everything listed passed on all three targets.

| Check | darwin-arm64 | darwin-x64 (Rosetta) | linux-x64 (Docker, debian slim) |
|---|---|---|---|
| Effect runtime, `effect/cli` command tree, `BunRuntime.runMain` | ok | ok | ok |
| Langium parse of a grammar subset, behind an Effect `Context.Service` | ok | ok | ok |
| Langium syntax error with location and expected tokens | ok | not run | ok |
| MCP SDK: `McpServer` + `Client` over `InMemoryTransport`, `listTools`, `callTool` calling an Effect program | ok | not run | ok |
| web-tree-sitter WASM runtime init, with the `.wasm` embedded via `import ... with { type: "file" }` | ok | not run | ok |
| `@effect/ai-anthropic` layer graph builds with no key | ok | not run | ok |
| `LanguageModel.generateText` round trip through the binary against a local stub of `POST /v1/messages` | ok | not run | not run |

"Not run" means that check wasn't repeated on that target. The `validate` subcommand ran on all three.

Binary sizes: 61 MB (darwin-arm64), 68 MB (darwin-x64), 79 MB (linux-x64). Build time is under 200 ms for the native target once the cross-compile runtimes are cached.

## Findings that change the brief

1. **Effect 4 is current (4.0.1).** In v4 the CLI, AI, HTTP, process and MCP modules ship inside `effect` itself as `effect/cli`, `effect/ai`, `effect/http` and `effect/process`. The separate `@effect/cli@0.77` and `@effect/ai@0.37` packages are on the v3 line and need `effect@^3`, so they can't be mixed with v4. Only `@effect/platform-bun` and `@effect/ai-anthropic` are still separate packages, both at 4.0.1. Some API names changed: `Context.Tag` became `Context.Service`, `Config.string` became `Config.String`, and `Argument.string` became `Argument.String`. The `cli` and `ai` modules are marked `@stability unstable`. See ADR 0001.
2. **Effect 4 has its own MCP server** (`effect/ai/McpServer`). The brief asks for the official SDK. Both work. The plan keeps the official SDK as briefed; see ADR 0008.
3. **No real Anthropic call was made** because `ANTHROPIC_API_KEY` is not set on this machine. The stub test covered the HTTP client, auth header, request encoding and strict response decoding. A real call would add only network and auth.
4. **The Anthropic response decoder is strict.** A response missing newer fields such as `container` or `usage.cache_creation` fails with `Invalid output: Missing key`. Test fakes should therefore sit at the `LanguageModel` service, not at HTTP. This matches the brief's "swap Layers, never mock modules" rule.
5. **The MCP SDK needs `zod`** (v4) for tool input schemas. The plan keeps zod at the MCP edge only and decodes into Effect Schema right away.
6. **Langium needs no special handling.** The `langium generate` output is plain TS, and `EmptyFileSystem` avoids any Node fs coupling.

## Reproduce

```bash
cd spike && bun install && bunx langium generate && bunx tsc
bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile dist/harness
dist/harness selftest
bun anthropic-stub.ts &   # then:
ANTHROPIC_API_KEY=sk-test ANTHROPIC_BASE_URL=http://127.0.0.1:8787 dist/harness selftest
```

The spike is throwaway. Nothing in `spike/` is carried into `packages/` except what is learned here.
