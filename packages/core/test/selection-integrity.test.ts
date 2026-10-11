import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { emptyBaseline } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import { deselectedBy, type DiffFacts, runIntegrity, type Selection, testPathMatcher, testsToCompare } from "../src/index.ts"
import { go, pack, ran, suite } from "./affected-runner.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Integrity knows what selection left out (spec 0013): a test of a class that
// didn't need to run isn't missing, and doesn't count against the ratchet.

describe("what selection leaves out", () => {
  test("the runner reports the classes its affected suites left out", async () => {
    const some: Selection = { kind: "some", classes: ["svc.FxTest"], files: [], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] }
    expect((await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { input: { selections: new Map([["unit", new Map([[".", some]])]]) } })).deselected)
      .toEqual(["svc.ClusterSpec", "svc.MoneyTest"])
    const all: Selection = { kind: "all", reason: "the check runs on trunk" }
    expect((await go(pack(suite(() => ran(["svc.FxTest.converts"]))), { input: { selections: new Map([["unit", new Map([[".", all]])]]) } })).deselected).toBeUndefined()
  })

  test("across suites and builds, for the trusted half to work out for itself", () => {
    const selections = new Map([
      ["unit", new Map<string, Selection>([["a", { kind: "some", classes: [], files: [], deselected: ["a:x.ATest"] }], ["b", { kind: "all", reason: "r" }]])],
      ["slow", new Map<string, Selection>([["a", { kind: "some", classes: [], files: [], deselected: ["a:x.ATest", "a:x.BTest"] }]])],
    ])
    expect(deselectedBy(selections)).toEqual(["a:x.ATest", "a:x.BTest"])
  })
})

describe("integrity with selection", () => {
  const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" affected }
integrity { ratchet executed tests }
gates { verify { unit } }
`)
  const baseline = Option.some({
    ...emptyBaseline("m", "h", "0"),
    testIds: ["svc.FxTest.converts", "svc.MoneyTest.adds", "svc.MoneyTest.subtracts"],
    metrics: { "integrity/executed-tests": { value: 3, unit: "count" as const, higherIsBetter: true } },
  })
  const judged = (deselected: string[], ids = ["svc.FxTest.converts"], files: DiffFacts["files"] = []) => {
    const compared = testsToCompare(baseline, { tests: { counts: { executed: ids.length, passed: ids.length, failed: 0, errored: 0, skipped: 0 }, ids }, deselected })
    const r = Effect.runSync(runIntegrity({
      ir, facts: noFacts({ files }), readBase: () => Effect.succeed(Option.none()), readHead: () => Effect.succeed(Option.none()),
      isTestPath: testPathMatcher(ir), headFiles: [], dir: "/nonexistent", ...compared,
    }, []).pipe(Effect.provide(BunServices.layer)))
    return { compared, findings: r.findings.map((f) => `${f.kind} ${f.check}${f.path ? ` ${f.path}` : ""}`) }
  }

  test("tests of a class left out are neither missing nor counted against the ratchet", () => {
    const { compared, findings } = judged(["svc.MoneyTest"])
    expect(compared.baseTestIds).toEqual(["svc.FxTest.converts"])
    expect(compared.baselineMetrics["integrity/executed-tests"]?.value).toBe(1)
    expect(findings).toEqual([])
  })

  test("without selection the same run is missing tests", () => {
    expect(judged([]).findings).toEqual(["forbid deleted-tests", "forbid deleted-tests", "ratchet executed-tests"])
  })

  test("a test of a class that ran, gone from it, is still missing; a deleted test file is still forbidden", () => {
    expect(judged(["svc.MoneyTest"], ["svc.FxTest.other"]).findings).toEqual(["forbid deleted-tests"])
    expect(judged(["svc.MoneyTest"], ["svc.FxTest.converts"], [{ path: "src/test/kotlin/svc/MoneyTest.kt", status: "deleted", added: 0, removed: 9 }]).findings)
      .toEqual(["forbid deleted-tests src/test/kotlin/svc/MoneyTest.kt"])
  })
})
