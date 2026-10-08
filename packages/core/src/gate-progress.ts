import { Context, Effect } from "effect"

// Told when each gate starts and ends, so a long check shows it's moving.
// Silent by default; the CLI supplies a terminal display for commands a person
// runs (check, baseline, apply), never for hooks or the MCP server.

export interface GateProgressShape {
  readonly start: (check: string) => Effect.Effect<void>
  readonly end: (check: string, status: string, ms: number) => Effect.Effect<void>
}

export const GateProgress = Context.Reference<GateProgressShape>("@gauntlet/core/GateProgress", {
  defaultValue: () => ({ start: () => Effect.void, end: () => Effect.void }),
})
