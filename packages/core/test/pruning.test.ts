import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { KillMap } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import { describePruning, type IntegrityInput, pruningVerdict, removedTests, runIntegrity, sameTest, testPathMatcher } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Spec 0016 §3, first half: a change that only removes tests is checked
// against the baseline's kill map. It stays forbidden until a mutation run
// confirms it; the report says what the kill map shows.

const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
gates { verify { unit } }
`)
const isTestPath = testPathMatcher(ir)
const modified = (path: string) => ({ path, status: "modified" as const, added: 0, removed: 5 })
const deleted = (path: string) => ({ path, status: "deleted" as const, added: 0, removed: 9 })
const FX = "src/main/kotlin/svc/Fx.kt"

const MAP: KillMap = {
  mutants: [{ path: FX, line: 3 }, { path: FX, line: 7 }, { path: FX, line: 9 }],
  tests: {
    "svc.FxTest.converts": { killed: [0, 1], reached: 2 },
    "svc.FxTest.rounds": { killed: [1], reached: 1 },
    "svc.FxTest.halves": { killed: [2], reached: 1 },
    "svc.FxTest.again": { killed: [0], reached: 1 },
  },
}

describe("sameTest", () => {
  test("drops a parameter list, so Gradle's and Pitest's names agree", () => {
    expect(sameTest("svc.FxTest.converts()")).toBe("svc.FxTest.converts")
    expect(sameTest("svc.FxTest.positive(int)")).toBe("svc.FxTest.positive")
    expect(sameTest("src/fx.test.ts > convert GBP (pounds) to USD")).toBe("src/fx.test.ts > convert GBP (pounds) to USD")
  })
})

describe("removedTests", () => {
  const base = ["svc.FxTest.converts()", "svc.FxTest.rounds()", "svc.FxTest.halves()"]
  test("a change to test files only, with tests that no longer run", () => {
    expect(removedTests({ files: [modified("src/test/kotlin/svc/FxTest.kt")] }, isTestPath, base, ["svc.FxTest.converts()", "svc.FxTest.halves()"])).toEqual(["svc.FxTest.rounds()"])
    expect(removedTests({ files: [deleted("src/test/kotlin/svc/FxTest.kt")] }, isTestPath, base, [])).toEqual(base)
  })

  test("not when main code changes too, nothing is removed, or the tests aren't known by name", () => {
    expect(removedTests({ files: [modified("src/test/kotlin/svc/FxTest.kt"), modified(FX)] }, isTestPath, base, [])).toBeUndefined()
    expect(removedTests({ files: [{ ...modified("src/main/kotlin/svc/FxTest.kt"), oldPath: "src/test/kotlin/svc/FxTest.kt", status: "renamed" as const }] }, isTestPath, base, [])).toBeUndefined()
    expect(removedTests({ files: [modified("src/test/kotlin/svc/FxTest.kt")] }, isTestPath, base, base)).toBeUndefined()
    expect(removedTests({ files: [modified("src/test/kotlin/svc/FxTest.kt")] }, isTestPath, undefined, [])).toBeUndefined()
    expect(removedTests({ files: [modified("src/test/kotlin/svc/FxTest.kt")] }, isTestPath, base, undefined)).toBeUndefined()
    expect(removedTests({ files: [] }, isTestPath, base, [])).toBeUndefined()
  })
})

describe("pruningVerdict", () => {
  test("keeps every kill when tests that stay kill all the removed tests' mutants", () => {
    expect(pruningVerdict(["svc.FxTest.rounds()"], MAP)).toEqual({ kind: "keeps-every-kill", removed: ["svc.FxTest.rounds()"], mutants: [{ path: FX, line: 7 }] })
  })

  test("loses kills when a mutant only removed tests kill", () => {
    expect(pruningVerdict(["svc.FxTest.halves()"], MAP)).toEqual({ kind: "loses-kills", removed: ["svc.FxTest.halves()"], lost: [{ path: FX, line: 9 }] })
  })

  test("removed together, two tests can't cover for each other", () => {
    const v = pruningVerdict(["svc.FxTest.converts()", "svc.FxTest.rounds()"], MAP)
    expect(v.kind).toBe("loses-kills")
    expect(v.kind === "loses-kills" && v.lost).toEqual([{ path: FX, line: 7 }])
  })

  test("unproven without a kill map, or for a test the map doesn't name", () => {
    expect(pruningVerdict(["svc.FxTest.rounds()"], undefined).kind).toBe("unproven")
    const v = pruningVerdict(["svc.FxTest.rounds()", "svc.FxTest.gone()"], MAP)
    expect(v).toEqual({ kind: "unproven", removed: ["svc.FxTest.rounds()", "svc.FxTest.gone()"], why: "the baseline's kill map doesn't name svc.FxTest.gone()" })
  })
})

describe("describePruning", () => {
  test("says what the kill map shows, and that it isn't enough yet", () => {
    expect(describePruning(pruningVerdict(["svc.FxTest.rounds()"], MAP))).toBe("Removing test svc.FxTest.rounds() keeps every kill: in the baseline's kill map, tests that stay kill all 1 of their mutants. It stays forbidden until a mutation run on the change confirms it (spec 0016).")
    expect(describePruning(pruningVerdict(["svc.FxTest.halves()"], MAP))).toBe(`Removing test svc.FxTest.halves() loses kills: no test that stays kills the mutant at ${FX}:9.`)
    expect(describePruning(pruningVerdict(["a", "b", "c", "d", "e", "f"], undefined))).toContain("Whether removing tests a, b, c, d, e and 1 more loses kills can't be told: the baseline records no kill map")
  })
})

describe("in the integrity checks", () => {
  const input = (over: Partial<IntegrityInput> = {}): IntegrityInput => ({
    ir, facts: noFacts({ files: [modified("src/test/kotlin/svc/FxTest.kt")] }),
    readBase: () => Effect.succeed(Option.none()), readHead: () => Effect.succeed(Option.none()),
    isTestPath, baselineMetrics: {}, headFiles: [], dir: "/nonexistent",
    baseTestIds: ["svc.FxTest.converts()", "svc.FxTest.rounds()"],
    headTests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.FxTest.converts()"] },
    ...over,
  })
  const run = (i: IntegrityInput) => Effect.runSync(runIntegrity(i, []).pipe(Effect.provide(BunServices.layer)))

  test("a removal the kill map supports is still forbidden, with a flag saying what the map shows", () => {
    const r = run(input({ killMap: MAP }))
    const removal = r.findings.filter((f) => f.check === "deleted-tests")
    expect(removal.map((f) => f.kind).sort()).toEqual(["flag", "forbid"])
    expect(removal.find((f) => f.kind === "flag")!.message).toContain("keeps every kill")
  })

  test("a change to main code gets no such flag", () => {
    const r = run(input({ killMap: MAP, facts: noFacts({ files: [modified("src/test/kotlin/svc/FxTest.kt"), modified(FX)] }) }))
    expect(r.findings.filter((f) => f.check === "deleted-tests").map((f) => f.kind)).toEqual(["forbid"])
  })
})
