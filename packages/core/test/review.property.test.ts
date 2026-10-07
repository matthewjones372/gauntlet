import { describe, expect, test } from "bun:test"
import { type Condition, type PolicyIR, type ReviewRule, TIER_ORDER } from "@gauntlet/ir"
import fc from "fast-check"
import { decide, type Evidence, type ReviewInput } from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

// Property tests for ADR 0005: whatever the facts and evidence, rules and
// caution signals can only add caution.

const base = compiled(`gauntlet "svc"
use jvm
owners @platform
zone money { paths "src/money/**" owner @payments }
suites { unit "src/test/**" }
gates { verify { unit } }
predicate small = diff < 150 lines and no zone touched
review { review when protected changed }
`)

const fact = fc.constantFrom<Condition>(
  { kind: "zone-touched" }, { kind: "no-zone-touched" }, { kind: "protected-changed" }, { kind: "dependency-added" },
  { kind: "budget-changed" }, { kind: "evidence-missing" }, { kind: "all-gates-pass" }, { kind: "predicate", name: "small" },
)
const condition: fc.Arbitrary<Condition> = fc.oneof(fact, fc.record({ kind: fc.constant("diff" as const), op: fc.constantFrom("<" as const, ">=" as const), lines: fc.integer({ min: 0, max: 500 }) }))
const rule: fc.Arbitrary<ReviewRule> = fc.record({ tier: fc.constantFrom(...TIER_ORDER), conditions: fc.array(condition, { minLength: 1, maxLength: 3 }) })

const world = fc.record({
  lines: fc.integer({ min: 0, max: 600 }),
  zone: fc.boolean(),
  protectedChange: fc.boolean(),
  dependency: fc.boolean(),
  gauntlet: fc.boolean(),
  status: fc.constantFrom("passed" as const, "failed" as const, "not-executed" as const),
  forbid: fc.boolean(),
  flag: fc.boolean(),
  caution: fc.boolean(),
  mode: fc.constantFrom("shadow" as const, "enforce" as const),
})

type World = typeof world extends fc.Arbitrary<infer T> ? T : never

const inputFor = (w: World, rules: ReadonlyArray<ReviewRule>, withCaution = w.caution): ReviewInput => {
  const evidence: Evidence = cleanEvidence({
    checks: [{ tier: "verify", check: "unit", pointer: "/gates/0/checks/0", status: w.status, advisory: false }],
    integrity: {
      findings: [
        ...(w.forbid ? [{ check: "new-skips" as const, kind: "forbid" as const, message: "skip", detector: "x" }] : []),
        ...(w.flag ? [{ check: "env-branching" as const, kind: "flag" as const, message: "env", detector: "x" }] : []),
      ],
      metrics: {},
      notExecuted: [],
    },
    caution: withCaution ? [{ source: "reviewer", message: "hm", raise: true }] : [],
  })
  const ir: PolicyIR = { ...base.ir, review: rules }
  return {
    ir,
    sourceMap: base.sourceMap,
    mode: w.mode,
    evidence,
    facts: noFacts({
      linesChanged: w.lines,
      zonesTouched: w.zone ? [{ zone: "money", files: ["src/money/A.kt"], owners: ["@payments"] }] : [],
      protectedTouched: w.protectedChange ? [{ path: "src/test/A.kt", group: "tests", kind: "tests", change: "modified", action: "restored" }] : [],
      dependencyChanges: w.dependency ? [{ manifest: "build.gradle.kts", added: ["a:b:1"], removed: [], unparsed: false }] : [],
      gauntletChanged: w.gauntlet,
    }),
  }
}

const rank = (t: string) => TIER_ORDER.indexOf(t as never)

describe("most cautious wins (property)", () => {
  // "No rule matched" is a default, not a rule: an `auto` rule that matches
  // replaces it (Q-R2). What no rule can do is undercut another nomination.
  test("adding a rule never lowers the tier below any other nomination, or unblocks", () => {
    fc.assert(fc.property(world, fc.array(rule, { maxLength: 5 }), rule, (w, rules, extra) => {
      const before = decide(inputFor(w, rules))
      const after = decide(inputFor(w, [...rules, extra]))
      const floor = Math.max(-1, ...before.nominations
        // The default and the caution step are relative to the rest, so they're not a floor.
        .filter((n) => !(n.source.kind === "implicit" && (n.source.rule === "no-rule-matched" || n.source.rule === "caution")))
        .map((n) => rank(n.tier)))
      expect(rank(after.tier)).toBeGreaterThanOrEqual(floor)
      if (before.wouldBlock) expect(after.wouldBlock).toBe(true)
    }), { numRuns: 500 })
  })

  test("adding a review or owner rule never lowers the tier", () => {
    const strict = rule.filter((r) => rank(r.tier) >= rank("review"))
    fc.assert(fc.property(world, fc.array(rule, { maxLength: 5 }), strict, (w, rules, extra) => {
      expect(rank(decide(inputFor(w, [...rules, extra])).tier)).toBeGreaterThanOrEqual(rank(decide(inputFor(w, rules)).tier))
    }), { numRuns: 500 })
  })

  test("a caution signal never lowers the tier and raises at most one step", () => {
    fc.assert(fc.property(world, fc.array(rule, { maxLength: 5 }), (w, rules) => {
      const without = rank(decide(inputFor(w, rules, false)).tier)
      const withSignal = rank(decide(inputFor(w, rules, true)).tier)
      expect(withSignal).toBeGreaterThanOrEqual(without)
      expect(withSignal - without).toBeLessThanOrEqual(1)
    }), { numRuns: 500 })
  })

  test("rule order doesn't change the decision", () => {
    fc.assert(fc.property(world, fc.array(rule, { maxLength: 5 }), (w, rules) => {
      const forward = decide(inputFor(w, rules))
      const backward = decide(inputFor(w, [...rules].reverse()))
      expect(backward.tier).toBe(forward.tier)
      expect(backward.wouldBlock).toBe(forward.wouldBlock)
    }), { numRuns: 300 })
  })

  test("caution alone can never make a failing change pass", () => {
    fc.assert(fc.property(world, fc.array(rule, { maxLength: 5 }), (w, rules) => {
      const failing = { ...w, status: "failed" as const, mode: "enforce" as const }
      expect(decide(inputFor(failing, rules, true)).blocking).toBe(true)
    }), { numRuns: 200 })
  })
})
