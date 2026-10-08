import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { codeUnderTest, type IntegrityInput, runIntegrity, testedName, testPathMatcher } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Removing a feature removes its tests too. A test deleted together with the
// code it tested is flagged for review; any other deleted test is forbidden.

const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
integrity { ratchet executed tests }
gates { verify { unit } }
`)

const input = (over: Partial<IntegrityInput> = {}): IntegrityInput => ({
  ir,
  facts: noFacts(),
  readBase: () => Effect.succeed(Option.none()),
  readHead: () => Effect.succeed(Option.none()),
  isTestPath: testPathMatcher(ir),
  baselineMetrics: {},
  headFiles: [],
  dir: "/nonexistent",
  ...over,
})
const run = (i: IntegrityInput) => Effect.runSync(runIntegrity(i, []).pipe(Effect.provide(BunServices.layer)))
const deleted = (path: string) => ({ path, status: "deleted" as const, added: 0, removed: 9 })
const counts = (executed: number) => ({ executed, passed: executed, failed: 0, errored: 0, skipped: 0 })
const summary = (r: ReturnType<typeof run>) => r.findings.filter((f) => f.check === "deleted-tests" || f.check === "executed-tests").map((f) => `${f.kind} ${f.check}${f.path ? ` ${f.path}` : ""}`)

describe("tests removed with the code they tested", () => {
  test("a test file deleted with its source file is a flag, not a forbid", () => {
    const r = run(input({ facts: noFacts({ files: [deleted("src/test/money/FxTest.kt"), deleted("src/main/money/Fx.kt")] }) }))
    expect(summary(r)).toEqual(["flag deleted-tests src/test/money/FxTest.kt"])
    expect(r.findings[0]!.message).toContain("removed along with src/main/money/Fx.kt")
  })

  test("a test file deleted while its code stays is still forbidden", () => {
    const r = run(input({ facts: noFacts({ files: [deleted("src/test/money/FxTest.kt"), deleted("src/main/money/Other.kt")] }) }))
    expect(summary(r)).toEqual(["forbid deleted-tests src/test/money/FxTest.kt"])
  })

  test("its tests that no longer run are flagged, and the executed-tests ratchet allows for exactly them", () => {
    const r = run(input({
      facts: noFacts({ files: [deleted("src/test/money/FxTest.kt"), deleted("src/main/money/Fx.kt")] }),
      baseTestIds: ["svc.money.FxTest.converts", "svc.money.FxTest.rounds", "svc.money.MoneyTest.adds"],
      headTests: { counts: counts(1), ids: ["svc.money.MoneyTest.adds"] },
      baselineMetrics: { "integrity/executed-tests": { value: 3, unit: "count", higherIsBetter: true } },
    }))
    expect(summary(r)).toEqual(["flag deleted-tests", "flag deleted-tests", "flag deleted-tests src/test/money/FxTest.kt"])
  })

  test("a test deleted from a file that stays still counts against the ratchet", () => {
    const r = run(input({
      facts: noFacts({ files: [deleted("src/test/money/FxTest.kt"), deleted("src/main/money/Fx.kt")] }),
      baseTestIds: ["svc.money.FxTest.converts", "svc.money.MoneyTest.adds", "svc.money.MoneyTest.subtracts"],
      headTests: { counts: counts(1), ids: ["svc.money.MoneyTest.adds"] },
      baselineMetrics: { "integrity/executed-tests": { value: 3, unit: "count", higherIsBetter: true } },
    }))
    expect(summary(r)).toEqual(["flag deleted-tests", "flag deleted-tests src/test/money/FxTest.kt", "forbid deleted-tests", "ratchet executed-tests"])
  })
})

describe("which code a test file is named after", () => {
  test("each language's naming", () => {
    expect(["src/test/FxTest.kt", "src/FxSpec.scala", "src/fx.test.ts", "src/fx.spec.tsx", "fx_test.go", "tests/test_fx.py", "test/svc/fx_test.clj", "src/FxSuite.scala"].map(testedName))
      .toEqual(["fx", "fx", "fx", "fx", "fx", "fx", "fx", "fx"])
  })

  test("pairs with a deleted source file of that name, wherever it lives", () => {
    expect(codeUnderTest("src/test/kotlin/svc/money/FxTest.kt", ["src/main/kotlin/svc/money/Fx.kt"])).toBe("src/main/kotlin/svc/money/Fx.kt")
    expect(codeUnderTest("src/money/rate_limit_test.go", ["src/money/rate-limit.go"])).toBe("src/money/rate-limit.go")
    expect(codeUnderTest("src/test/FxTest.kt", ["src/main/Money.kt"])).toBeUndefined()
  })
})
