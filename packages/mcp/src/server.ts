import { listAttempts } from "@gauntlet/core"
import { Effect, Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { GauntletTools, type ToolOptions, toolHandlers } from "./tools.ts"

// `gauntlet mcp`: the tools over stdio, for the coding agent that launched it.

export const INSTRUCTIONS = `Gauntlet judges this repository's changes before they merge.
- Call check before saying a task is done. A blocking result is a stop sign: fix the cause, never the check.
- Never edit protected paths (.gauntlet/, protected tests, test setup, build configuration) to make a check pass.
- If the task can't be done without changing protected tests or policy, call report_blocked with the reason and stop.`

export const PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05] as const

/** The URI of the agent hooks' outcomes, per branch (ADR 0026): JSON an orchestrator reads without parsing prose. */
export const ATTEMPTS_URI = "gauntlet://attempts"

// Read-only: what the Stop and SubagentStop hooks last recorded for each branch of the repository, worktrees included.
const attemptsResource = (o: ToolOptions) =>
  McpServer.resource({
    uri: ATTEMPTS_URI,
    name: "attempts",
    description: "The Stop and SubagentStop hooks' outcome per branch: blocked, exhausted or reported-blocked, with attempts, limits, fingerprint and last findings. Exhausted is a failure, never a pass.",
    mimeType: "application/json",
    content: listAttempts(o.repo).pipe(
      Effect.map((branches) => ({ contents: [{ uri: ATTEMPTS_URI, mimeType: "application/json", text: JSON.stringify({ branches }, null, 2) }] })),
    ),
  })

export const mcpServer = (o: ToolOptions) =>
  Layer.mergeAll(McpServer.toolkit(GauntletTools), attemptsResource(o)).pipe(
    Layer.provide(toolHandlers(o)),
    Layer.provideMerge(McpServer.layerStdio({ name: "gauntlet", version: o.gauntletVersion, instructions: INSTRUCTIONS, protocols: PROTOCOLS })),
  )
