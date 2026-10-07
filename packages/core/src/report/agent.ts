import type { Report } from "./schema.ts"

// What a coding agent is told about a check (Stop hook and MCP `check`):
// short, specific, and pointing at the fix rather than at the check.

export interface AgentSummary {
  readonly tier: string
  readonly wouldBlock: boolean
  readonly blocking: ReadonlyArray<string>
  readonly review: ReadonlyArray<string>
  readonly failedChecks: ReadonlyArray<{ readonly check: string; readonly status: string; readonly reason?: string; readonly failures?: ReadonlyArray<string> }>
  readonly fixes: ReadonlyArray<{ readonly check: string; readonly fix: string }>
  /** Suggestions that never affect the decision, such as a new area that may need a zone. */
  readonly suggestions: ReadonlyArray<string>
  readonly report: string
}

export const agentSummary = (report: Report, reportDir: string): AgentSummary => ({
  tier: report.decision.tier,
  wouldBlock: report.decision.wouldBlock,
  blocking: report.decision.nominations.filter((n) => n.blocking).slice(0, 10).map((n) => n.reason),
  review: report.decision.nominations.filter((n) => !n.blocking).slice(0, 10).map((n) => n.reason),
  failedChecks: report.checks.filter((c) => c.status !== "passed").map((c) => ({ check: c.check, status: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(c.failures ? { failures: c.failures } : {}) })),
  fixes: report.remediation,
  suggestions: report.policy.notes.filter((n) => n.includes("/gauntlet-setup")),
  report: `${reportDir}/gauntlet-report.md`,
})

export const NOT_THE_CHECK = "Fix the cause, not the check. If it can't be done without changing protected tests or policy, call the report_blocked tool (or run `gauntlet report blocked --reason \"...\"`) and stop."

/** Passed on to the person rather than acted on: the agent can't change the policy. */
const suggestionLines = (s: AgentSummary) =>
  s.suggestions.length > 0 ? ["Tell the person (don't change the policy yourself):", ...s.suggestions.map((x) => `- ${x}`)] : []

export const renderAgentSummary = (s: AgentSummary): string =>
  s.wouldBlock
    ? [
      "Gauntlet would block this change:",
      ...s.blocking.map((r) => `- ${r}`),
      ...s.failedChecks.flatMap((c) => (c.failures ? [`Failing in ${c.check}:`, ...c.failures.map((f) => `  - ${f}`)] : [])),
      ...(s.fixes.length > 0 ? ["How to fix:", ...s.fixes.map((f) => `- ${f.check}: ${f.fix}`)] : []),
      ...suggestionLines(s),
      NOT_THE_CHECK,
      `Full report: ${s.report}`,
    ].join("\n")
    : [
      `Gauntlet passes this change (tier ${s.tier}).`,
      ...(s.review.length > 0 ? ["It still needs a person's review because:", ...s.review.map((r) => `- ${r}`)] : []),
      ...suggestionLines(s),
      `Full report: ${s.report}`,
    ].join("\n")
