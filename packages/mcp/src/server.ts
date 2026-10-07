import { Layer } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { GauntletTools, type ToolOptions, toolHandlers } from "./tools.ts"

// `gauntlet mcp`: the tools over stdio, for the coding agent that launched it.

export const INSTRUCTIONS = `Gauntlet judges this repository's changes before they merge.
- Call check before saying a task is done. A blocking result is a stop sign: fix the cause, never the check.
- Never edit protected paths (.gauntlet/, protected tests, test setup, build configuration) to make a check pass.
- If the task can't be done without changing protected tests or policy, call report_blocked with the reason and stop.`

export const PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05] as const

export const mcpServer = (o: ToolOptions) =>
  McpServer.toolkit(GauntletTools).pipe(
    Layer.provide(toolHandlers(o)),
    Layer.provideMerge(McpServer.layerStdio({ name: "gauntlet", version: o.gauntletVersion, instructions: INSTRUCTIONS, protocols: PROTOCOLS })),
  )
