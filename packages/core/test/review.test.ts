import { describe, expect, test } from "bun:test"
import { decide, type Evidence, type ReviewInput } from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

const policy = compiled(`gauntlet "svc"
use jvm
owners @platform
protect {
  tests "src/test/**"
  config "*.gradle.kts"
}
zone money { paths "src/main/money/**" owner @payments }
suites { unit "src/test/**" }
gates { fast { build } verify { unit } }
predicate small = diff < 150 lines and no zone touched
review {
  owner when zone touched
  review when dependency added
  auto when small and all gates pass
}
`)

const passing: Evidence = cleanEvidence({
  checks: [
    { tier: "fast", check: "build", pointer: "/gates/0/checks/0", status: "passed", advisory: false },
    { tier: "verify", check: "unit", pointer: "/gates/1/checks/0", status: "passed", advisory: false },
  ],
})

const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  ...policy,
  facts: noFacts({ linesChanged: 20 }),
  evidence: passing,
  mode: "enforce",
  ...over,
})

describe("decide", () => {
  test("a small, clean change gets auto, citing the auto rule", () => {
    const d = decide(input())
    expect(d.tier).toBe("auto")
    expect(d.blocking).toBe(false)
    expect(d.nominations.map((n) => (n.source.kind === "policy" ? n.source.ref.text : n.source.rule))).toEqual(["auto when small and all gates pass"])
  })

  test("no matching rule means review", () => {
    const d = decide(input({ facts: noFacts({ linesChanged: 400 }) }))
    expect(d.tier).toBe("review")
    expect(d.nominations.map((n) => n.source.kind === "implicit" && n.source.rule)).toEqual(["no-rule-matched"])
  })

  test("touching a zone gets owner and suggests its owners", () => {
    const d = decide(input({ facts: noFacts({ linesChanged: 5, zonesTouched: [{ zone: "money", files: ["src/main/money/Fx.kt"], owners: ["@payments"] }] }) }))
    expect(d.tier).toBe("owner")
    expect(d.owners).toEqual(["@payments"])
  })

  test("a protected change gets review citing its protect group; a new test doesn't", () => {
    const modified = decide(input({ facts: noFacts({ linesChanged: 5, protectedTouched: [{ path: "build.gradle.kts", group: "config", kind: "config", change: "modified", action: "restored" }] }) }))
    expect(modified.tier).toBe("review")
    const n = modified.nominations.find((x) => x.source.kind === "implicit" && x.source.rule === "protected-changed")
    expect(n?.source.ref?.text).toBe("config \"*.gradle.kts\"")
    const added = decide(input({ facts: noFacts({ linesChanged: 5, protectedTouched: [{ path: "src/test/NewTest.kt", group: "tests", kind: "tests", change: "added", action: "kept" }] }) }))
    expect(added.tier).toBe("auto")
  })

  test("a .gauntlet/ change gets owner and suggests the policy owners", () => {
    const d = decide(input({ facts: noFacts({ linesChanged: 1, gauntletChanged: true, policyChanged: true, protectedTouched: [{ path: ".gauntlet/policy.gx", group: "gauntlet", kind: "gauntlet", change: "modified", action: "restored" }] }) }))
    expect(d.tier).toBe("owner")
    expect(d.owners).toEqual(["@platform"])
  })

  test("a failed gate blocks in enforce mode and only would block in shadow", () => {
    const failing = cleanEvidence({ checks: [{ tier: "verify", check: "unit", pointer: "/gates/1/checks/0", status: "failed", advisory: false, reason: "2 tests failed" }] })
    const enforce = decide(input({ evidence: failing }))
    expect([enforce.tier, enforce.wouldBlock, enforce.blocking]).toEqual(["review", true, true])
    expect(enforce.nominations.find((n) => n.blocking)?.source.ref?.text).toBe("gates { fast { build } verify { unit } }")
    const shadow = decide(input({ evidence: failing, mode: "shadow" }))
    expect([shadow.wouldBlock, shadow.blocking]).toEqual([true, false])
  })

  test("missing evidence gets review, doesn't block, and stops auto", () => {
    const d = decide(input({ evidence: cleanEvidence({ checks: [{ ...passing.checks[0]!, status: "passed" }, { ...passing.checks[1]!, status: "not-executed", reason: "holdout pending" }] }) }))
    expect(d.tier).toBe("review")
    expect(d.blocking).toBe(false)
    expect(d.nominations.some((n) => n.source.kind === "policy")).toBe(false)
  })

  test("integrity forbids block and flags only raise", () => {
    const forbid = decide(input({ evidence: { ...passing, integrity: { findings: [{ check: "new-skips", kind: "forbid", message: "new @Disabled", detector: "kotlin" }], metrics: {}, notExecuted: [] } } }))
    expect([forbid.tier, forbid.blocking]).toEqual(["review", true])
    const flag = decide(input({ evidence: { ...passing, integrity: { findings: [{ check: "env-branching", kind: "flag", message: "getenv in a condition", detector: "kotlin" }], metrics: {}, notExecuted: [] } } }))
    expect([flag.tier, flag.blocking]).toEqual(["review", false])
  })

  test("caution steps up exactly one tier, and never from below", () => {
    const signal = { source: "coderabbit", message: "suspicious", raise: true }
    expect(decide(input({ evidence: { ...passing, caution: [signal, signal] } })).tier).toBe("skim")
    expect(decide(input({ evidence: { ...passing, caution: [{ ...signal, raise: false }] } })).tier).toBe("auto")
    const zone = noFacts({ zonesTouched: [{ zone: "money", files: ["x"], owners: [] }] })
    expect(decide(input({ facts: zone, evidence: { ...passing, caution: [signal] } })).tier).toBe("owner")
  })

  test("report_blocked gets review", () => {
    const d = decide(input({ evidence: { ...passing, blocked: { reason: "needs a change to a protected test" } } }))
    expect(d.tier).toBe("review")
    expect(d.nominations.map((n) => n.reason)).toContain("The agent reported it was blocked: needs a change to a protected test")
  })

  test("every nomination cites its source", () => {
    const busy = decide(input({
      facts: noFacts({ linesChanged: 900, zonesTouched: [{ zone: "money", files: ["x"], owners: ["@p"] }], dependencyChanges: [{ manifest: "build.gradle.kts", added: ["x:y:1"], removed: [], unparsed: false }] }),
      evidence: cleanEvidence({ checks: [{ ...passing.checks[0]!, status: "failed" }], integrity: { findings: [], metrics: {}, notExecuted: ["executed-tests"] } }),
    }))
    expect(busy.nominations.length).toBeGreaterThan(3)
    for (const n of busy.nominations) {
      if (n.source.kind === "policy") {
        expect(n.source.ref.line).toBeGreaterThan(0)
        expect(n.source.ref.text).toMatch(/ when /)
      } else expect(n.source.rule).toBeTruthy()
    }
  })
})
