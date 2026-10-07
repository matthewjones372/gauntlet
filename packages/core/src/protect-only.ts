import type { Check, PolicyIR } from "@gauntlet/ir"
import type { Decision } from "./review.ts"

// `gauntlet check --protect-only` (spec 0001): the verification boundary and
// nothing else. The policy is reduced to the checks whose verdict needs no
// baseline, no zones and no review ladder, and the decision becomes a plain
// pass or fail.

/** Whether a check survives the reduction, and how. */
const reduceCheck = (c: Check): Check | undefined => {
  switch (c.kind) {
    case "suite":
      return c
    case "gate":
      // Mutation always needs a baseline-scale run and is left out entirely.
      if (c.name === "mutation") return undefined
      // Zone-scoped checks go with the zones.
      if (c.zone !== undefined) return undefined
      // A ratchet compares with the baseline: a check that is only a ratchet is
      // dropped, and a check with an absolute rule keeps the rule.
      if (c.ratchet && c.threshold === undefined) return undefined
      return { ...c, ratchet: false }
    default:
      // Holdouts, budgets and llm review aren't part of the boundary.
      return undefined
  }
}

/** The policy as protect-only runs it. Protected paths and suites are untouched. */
export const protectOnlyIr = (ir: PolicyIR): PolicyIR => ({
  ...ir,
  mode: "enforce",
  zones: [],
  review: [],
  imports: [],
  budgets: [],
  integrity: { ...ir.integrity, ratchet: [] },
  gates: ir.gates
    .map((t) => ({ ...t, checks: t.checks.flatMap((c) => present(reduceCheck(c))) }))
    .filter((t) => t.checks.length > 0),
})

const present = <A>(a: A | undefined): A[] => (a === undefined ? [] : [a])

/**
 * The verdict from the normal decision over the reduced policy: a failed gate,
 * missing evidence or an integrity forbid fails the change; everything else is
 * reported but doesn't. Always enforced, whatever the policy's mode.
 */
export const protectOnlyDecision = (d: Decision): Decision => {
  const nominations = d.nominations
    // Review rules aren't evaluated, so "no rule matched" says nothing here.
    .filter((n) => !(n.source.kind === "implicit" && n.source.rule === "no-rule-matched"))
    // Missing evidence is never a pass.
    .map((n) => (n.source.kind === "implicit" && n.source.rule === "missing-evidence" ? { ...n, blocking: true } : n))
  const failing = nominations.some((n) => n.blocking)
  return { ...d, tier: "review", nominations, wouldBlock: failing, blocking: failing, mode: "enforce" }
}
