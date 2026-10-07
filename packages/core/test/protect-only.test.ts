import { describe, expect, test } from "bun:test"
import { decide, githubStatus, protectOnlyDecision, protectOnlyIr, type Report, verdictLines } from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

// Spec 0001: protect-only keeps the verification boundary and drops the rest.

const POLICY = `gauntlet "svc"
use jvm
mode shadow
owners @platform

protect {
  tests "src/test/**"
}

zone money {
  paths "src/main/kotlin/money/**"
  owner @payments
}

suites { unit "src/test/**" }

gates {
  fast   { build, lint ratchet, arch }
  verify { unit, coverage ratchet >= 80% on changed, coverage ratchet in zone money, mutation ratchet on changed }
}

review {
  owner  when zone touched
  auto   when all gates pass
}
`

describe("the protect-only policy", () => {
  const ir = compiled(POLICY).ir
  const reduced = protectOnlyIr(ir)
  const checks = reduced.gates.flatMap((t) => t.checks.map((c) => `${t.name}:${c.kind === "gate" ? `${c.name}${c.ratchet ? " ratchet" : ""}${c.threshold ? ` ${c.threshold.op} ${c.threshold.value.value}` : ""}` : c.kind === "suite" ? c.name : c.kind}`))

  test("keeps absolute checks and suites; drops mutation, ratchet-only and zone checks", () => {
    expect(checks).toEqual(["fast:arch", "fast:build", "verify:coverage >= 80", "verify:unit"])
  })

  test("drops zones, review rules and integrity ratchets; keeps protected paths and forbids; always enforces", () => {
    expect([reduced.zones, reduced.review, reduced.integrity.ratchet, reduced.mode]).toEqual([[], [], [], "enforce"])
    expect(reduced.protect).toEqual(ir.protect)
    expect(reduced.integrity.forbid).toEqual(ir.integrity.forbid)
    expect(reduced.integrity.forbid).toContain("weakened-assertions")
  })
})

describe("the protect-only verdict", () => {
  const ir = protectOnlyIr(compiled(POLICY).ir)
  const { sourceMap } = compiled(POLICY)
  const verdict = (evidence: Parameters<typeof cleanEvidence>[0]) =>
    protectOnlyDecision(decide({ ir, sourceMap, facts: noFacts(), evidence: cleanEvidence(evidence), mode: "shadow" }))

  test("passes when every check passed and nothing was forbidden, even under mode shadow", () => {
    const d = verdict({ checks: [{ tier: "verify", check: "unit", status: "passed", pointer: "/gates/1/checks/0", advisory: false }] })
    expect([d.blocking, d.mode, d.tier]).toEqual([false, "enforce", "review"])
    expect(d.nominations.map((n) => n.source.kind === "implicit" ? n.source.rule : "policy")).not.toContain("no-rule-matched")
  })

  test("a failed gate, missing evidence or an integrity forbid fails it", () => {
    expect(verdict({ checks: [{ tier: "verify", check: "unit", status: "failed", pointer: "/gates/1/checks/0", advisory: false }] }).blocking).toBe(true)
    expect(verdict({ checks: [{ tier: "verify", check: "unit", status: "not-executed", reason: "no tests ran", pointer: "/gates/1/checks/0", advisory: false }] }).blocking).toBe(true)
    expect(verdict({ integrity: { findings: [{ check: "weakened-assertions", kind: "forbid", message: "assertTrue(true) can't fail.", path: "src/test/A.kt", detector: "jvm" }], metrics: {}, notExecuted: [] } }).blocking).toBe(true)
  })

  test("an integrity flag is reported but doesn't fail it", () => {
    const d = verdict({ integrity: { findings: [{ check: "env-branching", kind: "flag", message: "System.getenv decides a branch.", path: "src/main/A.kt", detector: "jvm" }], metrics: {}, notExecuted: [] } })
    expect(d.blocking).toBe(false)
    expect(d.nominations.some((n) => n.reason.startsWith("System.getenv"))).toBe(true)
  })
})

describe("the two lines on every GitHub check", () => {
  const report = (over: Partial<{ scope: "protect-only"; blocking: boolean; tier: Report["decision"]["tier"]; findings: Report["integrity"]["findings"]; checks: Report["checks"] }>): Report => ({
    policy: { irHash: "ir", headSha: "h".repeat(40), owners: ["@platform"] },
    integrity: { findings: over.findings ?? [], notExecuted: [] },
    checks: over.checks ?? [],
    decision: {
      ...(over.scope ? { scope: over.scope } : {}),
      tier: over.tier ?? "auto", mode: "enforce", blocking: over.blocking ?? false, wouldBlock: over.blocking ?? false, owners: [], overrides: [],
      nominations: over.blocking ? [{ tier: "review", reason: "unit failed: 1 of 4 tests failed", blocking: true, rule: "gate-failed" }] : [],
    },
  }) as unknown as Report
  const passed = (check: string) => ({ tier: "verify", check, status: "passed" as const, advisory: false })

  test("integrity first, then gates, kept apart even when everything passes", () => {
    const r = report({ checks: [passed("build"), passed("unit")] })
    expect(verdictLines(r)).toEqual(["Integrity: no forbidden changes.", "Gates: 2 passed."])
    const s = githubStatus(r, [], {}, [])
    expect(s.title).toBe("Auto: no review needed")
    expect(s.summary.split("\n").slice(0, 2)).toEqual(["Integrity: no forbidden changes.", "Gates: 2 passed."])
  })

  test("names forbidden changes, flags, failed and missing checks", () => {
    const r = report({
      findings: [
        { check: "weakened-assertions", kind: "forbid", message: "m", detector: "jvm" },
        { check: "new-skips", kind: "forbid", message: "m", detector: "jvm" },
        { check: "env-branching", kind: "flag", message: "m", detector: "jvm" },
      ],
      checks: [passed("build"), { tier: "verify", check: "unit", status: "failed", advisory: false }, { tier: "verify", check: "coverage", status: "not-executed", advisory: false }],
    })
    expect(verdictLines(r)).toEqual([
      "Integrity: 2 forbidden changes (weakened assertions, new skips); 1 flag (env branching).",
      "Gates: 1 passed, 1 failed (unit), 1 not executed (coverage).",
    ])
  })

  test("protect-only is pass or fail, whatever the reviews", () => {
    expect(githubStatus(report({ scope: "protect-only" }), [], {}, [])).toMatchObject({ conclusion: "success", title: "Protect-only: passed" })
    const failed = githubStatus(report({ scope: "protect-only", blocking: true }), [{ user: "alice", state: "APPROVED", commitId: "h".repeat(40) }], {}, [])
    expect(failed).toMatchObject({ conclusion: "failure", title: "Protect-only: failed" })
    expect(failed.summary.split("\n")[3]).toBe("unit failed: 1 of 4 tests failed")
  })
})
