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
  /** Zones the change touches, with their owners and files: where a person should look. */
  readonly zones: ReadonlyArray<{ readonly zone: string; readonly owners: ReadonlyArray<string>; readonly files: ReadonlyArray<string> }>
  /** The commit an approval is for. */
  readonly head: string
  /** Suggestions that never affect the decision, such as a new area that may need a zone. */
  readonly suggestions: ReadonlyArray<string>
  /** For a big change over several parts: the stacked pull requests to offer, in review order. */
  readonly stack?: ReadonlyArray<{ readonly title: string; readonly files: ReadonlyArray<string>; readonly lines: number }>
  readonly report: string
}

export const agentSummary = (report: Report, reportDir: string): AgentSummary => ({
  tier: report.decision.tier,
  wouldBlock: report.decision.wouldBlock,
  blocking: report.decision.nominations.filter((n) => n.blocking).slice(0, 10).map((n) => n.reason),
  review: report.decision.nominations.filter((n) => !n.blocking).slice(0, 10).map((n) => n.reason),
  failedChecks: report.checks.filter((c) => c.status !== "passed").map((c) => ({ check: c.check, status: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(c.failures ? { failures: c.failures } : {}) })),
  fixes: report.remediation,
  zones: report.facts.zonesTouched,
  head: report.policy.headSha,
  suggestions: report.policy.notes.filter((n) => n.includes("/gauntlet-setup")),
  ...(report.stack ? { stack: report.stack.steps.map((s) => ({ title: s.title, files: s.files, lines: s.lines })) } : {}),
  report: `${reportDir}/gauntlet-report.md`,
})

export const NOT_THE_CHECK = "Fix the cause, not the check. If it can't be done without changing protected tests or policy, call the report_blocked tool (or run `gauntlet report blocked --reason \"...\"`) and stop."

/** Passed on to the person rather than acted on: the agent can't change the policy. */
const suggestionLines = (s: AgentSummary) => [
  ...(s.suggestions.length > 0 ? ["Tell the person (don't change the policy yourself):", ...s.suggestions.map((x) => `- ${x}`)] : []),
  // Offered, never done unasked: splitting rewrites the person's branch.
  ...(s.stack && s.stack.length > 1
    ? [
      `This change is big. Offer the person to split it into ${s.stack.length} stacked pull requests, each on top of the one before, and only do it if they agree:`,
      ...s.stack.map((p, i) => `${i + 1}. ${p.title} (${p.lines} lines): ${p.files.slice(0, 5).join(", ")}${p.files.length > 5 ? ` and ${p.files.length - 5} more` : ""}`),
      "If they agree: make one branch per part, in this order, each starting from the one before (the first from the default branch), with only that part's files changed. Keep each part's tests with the code they exercise, wherever the test files live, and run Gauntlet's check on every branch, not only the tests: each must pass on its own, coverage included. Push them and open one pull request per branch, each based on the branch before, and say in each which part of the stack it is. Tell the person that ticking the box on the top pull request approves the whole stack, and that the stack merges bottom first with merge commits (`gh pr merge --merge`), since a squash gives the pull requests above new commits to approve again, deleting each branch as it merges (`--delete-branch`) so the next pull request moves onto the default branch instead of merging into the branch below. Keep the original branch until the stack is open, and tell the person when it is.",
    ]
    : []),
]

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
    : s.tier === "review" || s.tier === "owner"
    ? [
      `Gauntlet passes this change, but it needs ${s.tier === "owner" ? "an owner's" : "a person's"} approval before it merges.`,
      `Say so plainly at the end of your reply, in these words or close to them: "I need you to approve this change${s.zones.length > 0 ? `: it touches ${s.zones.map((z) => z.zone).join(", ")}` : ""}." Then list why:`,
      ...s.review.map((r) => `- ${r}`),
      ...s.zones.map((z) => `- Zone ${z.zone}${z.owners.length > 0 ? ` (owner ${z.owners.join(", ")})` : ""}: ${z.files.slice(0, 5).join(", ")}${z.files.length > 5 ? ` and ${z.files.length - 5} more` : ""}`),
      `On GitHub they approve the pull request (Files changed, Review changes, Approve), or, if they opened it, comment \`/gauntlet approve ${s.head.slice(0, 12)}\`.`,
      ...suggestionLines(s),
      `Full report: ${s.report}`,
    ].join("\n")
    : [
      `Gauntlet passes this change (tier ${s.tier}).`,
      ...(s.review.length > 0 ? ["It still needs a person's review because:", ...s.review.map((r) => `- ${r}`)] : []),
      ...suggestionLines(s),
      `Full report: ${s.report}`,
    ].join("\n")
