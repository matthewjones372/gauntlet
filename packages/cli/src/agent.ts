import type { ReportAgent } from "@gauntlet/core"

// Who wrote the change, when the environment says. Recorded in the report
// only; it never affects the decision (invariant 7).
export const agentFromEnv = (env: Readonly<Record<string, string | undefined>>): ReportAgent => {
  const agent = env.GAUNTLET_AGENT ?? (env.CLAUDECODE === "1" ? "claude-code" : undefined)
  return {
    ...(agent ? { agent } : {}),
    ...(env.GAUNTLET_MODEL ? { model: env.GAUNTLET_MODEL } : {}),
    ...(env.GAUNTLET_SESSION ? { session: env.GAUNTLET_SESSION } : {}),
  }
}
