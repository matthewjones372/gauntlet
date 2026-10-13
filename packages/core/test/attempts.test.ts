import { describe, expect, test } from "bun:test"
import {
  type Attempt, attemptNote, type AttemptRecord, exhaustedLine, fingerprintLines, fingerprintOf, nextAttempt, type Previous, reportedBlocked,
} from "../src/attempts.ts"
import type { Report } from "../src/report/schema.ts"

// The attempt counter of ADR 0026: fingerprints that hold still across runs,
// and counts that only an honest pass or a person resets.

type Parts = {
  readonly checks?: ReadonlyArray<Record<string, unknown>>
  readonly violations?: ReadonlyArray<Record<string, unknown>>
  readonly ratchets?: ReadonlyArray<Record<string, unknown>>
  readonly findings?: ReadonlyArray<Record<string, unknown>>
  readonly nominations?: ReadonlyArray<Record<string, unknown>>
}

const report = (p: Parts): Report => ({
  checks: p.checks ?? [],
  violations: p.violations ?? [],
  ratchets: p.ratchets ?? [],
  integrity: { findings: p.findings ?? [], notExecuted: [] },
  decision: { nominations: p.nominations ?? [] },
}) as unknown as Report

const failingUnit = (failures: ReadonlyArray<string>, reason = "1 of 2 tests failed") =>
  report({
    checks: [{ tier: "verify", check: "unit", status: "failed", advisory: false, reason, failures }],
    nominations: [{ tier: "review", reason: `unit failed: ${reason}`, blocking: true, rule: "gate-failed" }],
  })

describe("fingerprints", () => {
  test("hold still when messages, counts and lines drift", () => {
    const a = fingerprintLines(failingUnit(["svc.AddTest.add: expected 2 but was 3"], "1 of 2 tests failed"))
    const b = fingerprintLines(failingUnit(["svc.AddTest.add: expected 2 but was 4"], "1 of 3 tests failed"))
    expect(a).toEqual(["gate unit failed", "rule gate-failed", "test unit svc.AddTest.add"])
    expect(fingerprintOf(a)).toBe(fingerprintOf(b))
    const atLine = (line: number) => fingerprintLines(report({
      findings: [{ check: "new-skips", kind: "forbid", message: `skip added at line ${line}`, path: "src/test/A.kt", line, detector: "jvm" }],
      nominations: [{ tier: "review", reason: `skip added at line ${line}`, blocking: true, rule: "integrity-forbid" }],
    }))
    expect(atLine(10)).toEqual(atLine(42))
    expect(atLine(10)).toEqual(["integrity forbid new-skips src/test/A.kt", "rule integrity-forbid"])
  })

  test("are the same whatever order the findings come in", () => {
    const v = (path: string) => ({ check: "lint", ruleId: "no-var", message: "m", path, line: 3 })
    const one = report({ violations: [v("a.kt"), v("b.kt")], nominations: [{ tier: "review", reason: "x", blocking: true, rule: "new-violation" }] })
    const two = report({ violations: [v("b.kt"), v("a.kt")], nominations: [{ tier: "review", reason: "y", blocking: true, rule: "new-violation" }] })
    expect(fingerprintOf(fingerprintLines(one))).toBe(fingerprintOf(fingerprintLines(two)))
  })

  test("change when the gate, the failing test, the file, the kind or the rule changes", () => {
    const base = fingerprintOf(fingerprintLines(failingUnit(["svc.AddTest.add: boom"])))
    expect(fingerprintOf(fingerprintLines(failingUnit(["svc.RoundTest.round: boom"])))).not.toBe(base)
    const finding = (over: Record<string, unknown>) =>
      fingerprintOf(fingerprintLines(report({ findings: [{ check: "new-skips", kind: "forbid", message: "m", path: "a.kt", detector: "d", ...over }] })))
    expect(finding({ path: "b.kt" })).not.toBe(finding({}))
    expect(finding({ check: "new-suppressions" })).not.toBe(finding({}))
    expect(finding({ kind: "ratchet" })).not.toBe(finding({}))
  })

  test("leave out what doesn't block: flags, advisory checks, failures already on the base", () => {
    expect(fingerprintLines(report({
      checks: [
        { check: "llm", status: "failed", advisory: true },
        { check: "unit", status: "failed", advisory: false, failedBefore: true, failures: ["svc.A.a: x (fails on the base too)"] },
        { check: "lint", status: "not-executed", advisory: false },
      ],
      findings: [{ check: "env-branching", kind: "flag", message: "m", detector: "d" }],
      ratchets: [{ metric: "coverage", base: 80, head: 85, delta: 5, regressed: false }],
      nominations: [{ tier: "review", reason: "x", blocking: false, rule: "integrity-flag" }],
    }))).toEqual([])
  })
})

const limits = { unchanged: 3, total: 8 }
const same: Attempt = { fingerprint: "f1", findings: ["gate unit failed"], reasons: ["gate-failed: unit failed"] }
const other: Attempt = { fingerprint: "f2", findings: ["gate lint failed"], reasons: ["gate-failed: lint failed"] }
const run = (attempts: ReadonlyArray<Attempt>, start: Previous = { kind: "fresh" }) =>
  attempts.reduce<{ previous: Previous; records: AttemptRecord[] }>((acc, a) => {
    const record = nextAttempt("feature", acc.previous, a, limits)
    return { previous: { kind: "ok", record }, records: [...acc.records, record] }
  }, { previous: start, records: [] }).records

describe("counting", () => {
  test("the same findings block three times, and the fourth stop is exhausted", () => {
    const records = run([same, same, same, same])
    expect(records.map((r) => `${r.status} ${r.attempts.unchanged}/${r.attempts.total}`)).toEqual([
      "blocked 1/1", "blocked 2/2", "blocked 3/3", "exhausted 4/4",
    ])
  })

  test("different findings reset the unchanged count, never the total", () => {
    const records = run([same, other, same, other, same, other, same, other, same])
    expect(records.map((r) => r.attempts.unchanged)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(records.map((r) => r.status)).toEqual([...Array(8).fill("blocked"), "exhausted"])
    expect(records.at(-1)!.attempts.total).toBe(9)
  })

  test("progress partway through starts the unchanged count again", () => {
    const records = run([same, same, other, other, other, other])
    expect(records.map((r) => `${r.status} ${r.attempts.unchanged}`)).toEqual([
      "blocked 1", "blocked 2", "blocked 1", "blocked 2", "blocked 3", "exhausted 4",
    ])
  })

  test("a missing or corrupt record counts as at both limits: exhausted at once, whatever the findings", () => {
    for (const state of ["missing", "corrupt"] as const) {
      const r = nextAttempt("feature", { kind: "untrusted", state }, same, limits)
      expect(r).toMatchObject({ status: "exhausted", state, attempts: { unchanged: 4, total: 9 } })
      // And it stays exhausted on the next stop, the same findings or not.
      expect(nextAttempt("feature", { kind: "ok", record: r }, other, limits).status).toBe("exhausted")
    }
  })

  test("is deterministic: the record is exactly its inputs, with no clock in it", () => {
    expect(run([same, other, same]).at(-1)).toEqual({
      version: 1,
      status: "blocked",
      branch: "feature",
      attempts: { unchanged: 1, total: 3 },
      limits: { unchanged: 3, total: 8 },
      fingerprint: "f1",
      findings: ["gate unit failed"],
      reasons: ["gate-failed: unit failed"],
      state: "ok",
    })
  })

  test("a reported block keeps the counts and the fingerprint, so counting resumes where it was", () => {
    const [first] = run([same])
    const waiting = reportedBlocked("feature", { kind: "ok", record: first! }, other, limits, "needs a fixture change")
    expect(waiting).toMatchObject({ status: "reported-blocked", attempts: { unchanged: 1, total: 1 }, fingerprint: "f1", reportedReason: "needs a fixture change" })
    expect(nextAttempt("feature", { kind: "ok", record: waiting }, same, limits).attempts).toEqual({ unchanged: 2, total: 2 })
    // A reported block never clears a missing record's debt.
    expect(reportedBlocked("feature", { kind: "untrusted", state: "missing" }, same, limits, "x").attempts).toEqual(limits)
  })
})

describe("what the agent and the orchestrator are told", () => {
  test("the block before the last one warns; earlier ones don't", () => {
    const records = run([same, same, same])
    expect(attemptNote(records[0]!)).toBe("Gauntlet attempt 1 of 3 on these findings, 1 of 8 on this branch.")
    expect(attemptNote(records[2]!)).toContain("If your next stop finds the same, Gauntlet lets you stop as exhausted.")
    const atTotal = run([same, other, same, other, same, other, same, other])
    expect(attemptNote(atTotal.at(-1)!)).toContain("If your next stop is blocked again, Gauntlet lets you stop as exhausted.")
  })

  test("the exhausted line says why, in one line", () => {
    const records = run([same, same, same, same])
    expect(exhaustedLine(records.at(-1)!)).toBe("Gauntlet: exhausted on feature (blocked 3 times in a row on the same findings). The change still fails its checks; details: gauntlet hook status --json")
    expect(exhaustedLine(nextAttempt("feature", { kind: "untrusted", state: "missing" }, same, limits))).toContain("its attempt record was missing")
    expect(exhaustedLine(run([same, other, same, other, same, other, same, other, same]).at(-1)!)).toContain("blocked 8 times on this branch")
  })
})
