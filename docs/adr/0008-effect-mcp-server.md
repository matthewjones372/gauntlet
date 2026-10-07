# 0008. Use Effect's MCP server

Status: accepted (2026-10-07, replaces the earlier proposal to use the official SDK)

## Context
The brief named the official MCP TypeScript SDK. Effect 4 ships `effect/ai/McpServer` with stdio and HTTP transports, tools, resources, prompts and elicitation. Both run in the compiled binary (spike).

## Decision
Use `effect/ai/McpServer`. MCP tools are an `effect/ai` `Toolkit` defined with Effect Schema. The read-only tools the authoring agent uses are defined once and registered with both the agent and the MCP server where they overlap. Handlers stay thin and call core Effect programs.

## Consequences
- Schema is used end to end, so there is no zod and no second set of tool definitions.
- The module is marked unstable. The version is pinned, and in-memory client tests per tool catch protocol regressions on upgrade.
- If it proves immature, the official SDK remains a fallback that only affects `packages/mcp`.

## Implementation (M13)
- `packages/mcp` defines the tools as one `Toolkit` and serves it with `McpServer.layerStdio`, offering protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. Tools that only read are annotated read-only; none is destructive or open-world.
- MCP clients may call tools concurrently. `check` and `report_blocked` read and write repository state, so they hold a one-permit semaphore, and each working-tree snapshot uses its own temporary index.
- Tool failures are returned as results (`isError`) with a readable message, so the agent sees why rather than a protocol error.
- The server runs until the client closes stdin, which ends the program with an interruption; `main.ts` exits 0 for an interruption-only exit and 2 for any other failure.
- Tests drive the real server over an in-memory `Stdio` with JSON-RPC requests: one session per scenario, waiting for every response before closing stdin.
