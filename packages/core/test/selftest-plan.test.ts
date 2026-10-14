import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BUILT_IN_FIXTURES, PackRegistry, planSelftest, renderSelftestText, type SelftestResult } from "../src/index.ts"
import { compiled } from "./fixtures.ts"
import { CoreTest, testPacks } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

// The dry run the authoring agent cites gaps from, and selftest's terminal text.

const POLICY = `gauntlet "svc"
use jvm
mode enforce
owners @platform
suites { unit "src/test/**" }
gates { verify { unit, coverage >= 80% on changed } }
`

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const plan = (repo: string, base?: string) =>
  Effect.runPromise(
    planSelftest({ repo, ...(base ? { base } : {}), ir: compiled(POLICY).ir }).pipe(Effect.provide(Layer.merge(CoreTest, PackRegistry.layer(testPacks)))),
  )

describe("planSelftest", () => {
  test("lists the fixtures the project gives something to tamper with, and the rest as not applicable", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ ".gauntlet/policy.gx": POLICY, "src/main/kotlin/A.kt": "class A", "src/test/kotlin/ATest.kt": "class ATest" })
    const before = r.commit("policy, no baseline")
    r.write({ ".gauntlet/baseline.sarif": `{"metrics":{"coverage":{"value":91}}}` })
    r.commit("baseline")

    const withBaseline = await plan(r.dir)
    expect(withBaseline.fixtures.map((f) => f.fixture)).toEqual(["lowered-threshold", "edited-baseline", "fake-result-file"])
    expect(withBaseline.fixtures.find((f) => f.fixture === "lowered-threshold")).toEqual({
      fixture: "lowered-threshold", description: "the change lowers a threshold in the policy", paths: [".gauntlet/policy.gx"],
    })
    expect(withBaseline.fixtures.find((f) => f.fixture === "fake-result-file")?.paths).toEqual([
      "build/test-results/test/TEST-gauntlet-fake.xml", "junit.xml", "target/surefire-reports/TEST-gauntlet-fake.xml", "test-results/gauntlet-fake.xml",
    ])
    expect(withBaseline.notApplicable).toEqual(BUILT_IN_FIXTURES.filter((f) => !["lowered-threshold", "edited-baseline", "fake-result-file"].includes(f)))

    // At a base with no baseline yet, there's no baseline to edit.
    const atBefore = await plan(r.dir, before)
    expect(atBefore.fixtures.map((f) => f.fixture)).toEqual(["lowered-threshold", "fake-result-file"])
    expect(atBefore.notApplicable).toContain("edited-baseline")
  })
})

const result = (over: Partial<SelftestResult> = {}): SelftestResult => ({
  base: "0123456789abcdef",
  control: { tier: "auto", wouldBlock: false, executed: 4, reasons: [] },
  fixtures: [{ fixture: "deleted-test", description: "a test is deleted", caught: true, why: "caught by a deleted-test finding", tier: "review", gatesRan: false }],
  notApplicable: [],
  passed: true,
  ...over,
})

describe("renderSelftestText", () => {
  test("a control that blocks says so and lists why, instead of the control's tier", () => {
    const text = renderSelftestText(result({ control: { tier: "review", wouldBlock: true, executed: 0, reasons: ["gate unit failed", "coverage 70% doesn't meet >= 80%"] }, passed: false }))
    expect(text).toContain("The policy blocks an empty change, so no fixture result means anything yet. Fix these first:\n  - gate unit failed\n  - coverage 70% doesn't meet >= 80%\n")
    expect(text).not.toContain("Control (an empty change)")
    expect(text).toContain("1 of 1 tamperings were caught.")
  })

  test("the attempt record's tamperings get a section of their own, missed ones marked", () => {
    const text = renderSelftestText(result({
      hookState: [
        { tamper: "none", description: "no tampering", caught: true, status: "blocked", state: "" },
        { tamper: "delete-record", description: "the attempt record is deleted", caught: false, status: "blocked", state: "" },
      ],
      passed: false,
    }))
    expect(text).toContain("Control (an empty change): auto, 4 tests ran.")
    expect(text).toContain("The agent hooks' attempt record:\n  caught  none            blocked  no tampering\n  MISSED  delete-record   blocked  the attempt record is deleted")
  })

  test("without a hook-state run there's no attempt-record section", () => {
    const text = renderSelftestText(result())
    expect(text).not.toContain("attempt record")
    expect(text).toContain("All 1 tamperings were caught.")
  })
})
