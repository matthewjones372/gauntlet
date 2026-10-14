import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { emptyBaseline } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import { type DiffFacts, removedTests, runIntegrity, testPathMatcher, testsToCompare } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Bun's tests are named after their files (ADR 0027). A baseline recorded
// before that names them by describe path and name only: integrity compares
// those with the head's new names, never inventing a deleted test, while a
// test that really went is still missing.

const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "test/**" }
suites { unit "test/**" }
integrity { ratchet executed tests }
gates { verify { unit } }
`)

const HEAD = ["test/a.test.ts.grp.x", "test/a.test.ts.money.adds", "test/a.test.ts.top", "test/sub/b.test.ts.grp.x", "test/sub/b.test.ts.top"]
/** The same tests as an older version named them: the two files' `grp.x` and `.top` were one id each. */
const OLD = [".top", "grp.x", "money.adds"]

const judged = (baseIds: string[], ids: string[], files: DiffFacts["files"] = []) => {
  const baseline = Option.some({
    ...emptyBaseline("m", "h", "0.1.0-rc.29"),
    testIds: baseIds,
    metrics: { "integrity/executed-tests": { value: baseIds.length, unit: "count" as const, higherIsBetter: true } },
  })
  const compared = testsToCompare(baseline, { tests: { counts: { executed: ids.length, passed: ids.length, failed: 0, errored: 0, skipped: 0 }, ids } })
  const r = Effect.runSync(runIntegrity({
    ir, facts: noFacts({ files }), readBase: () => Effect.succeed(Option.none()), readHead: () => Effect.succeed(Option.none()),
    isTestPath: testPathMatcher(ir), headFiles: [], dir: "/nonexistent", ...compared,
  }, []).pipe(Effect.provide(BunServices.layer)))
  return r.findings.filter((f) => f.check === "deleted-tests" || f.check === "executed-tests").map((f) => `${f.kind} ${f.check}: ${f.message}`)
}

describe("bun tests named after their files", () => {
  test("deleting one of two same-named tests in different files is caught", () => {
    expect(judged(HEAD, HEAD.filter((id) => id !== "test/sub/b.test.ts.grp.x")))
      .toEqual([
        "forbid deleted-tests: Test test/sub/b.test.ts.grp.x ran at base and no longer runs.",
        "ratchet executed-tests: executed tests went from 5 to 4; it may not get worse than the baseline.",
      ])
  })
})

describe("a baseline recorded with bun's older ids", () => {
  test("raises nothing when no test was removed", () => {
    expect(judged(OLD, HEAD)).toEqual([])
  })

  test("still catches a test that was removed", () => {
    expect(judged(OLD, HEAD.filter((id) => id !== "test/a.test.ts.money.adds")))
      .toEqual(["forbid deleted-tests: Test money.adds ran at base and no longer runs."])
  })

  test("doesn't invent a deletion when one of two tests that shared an old id goes", () => {
    expect(judged(OLD, HEAD.filter((id) => id !== "test/sub/b.test.ts.grp.x"))).toEqual([])
  })

  test("a change that only removes a test names it once, as the head would have", () => {
    const facts = { files: [{ path: "test/a.test.ts", status: "modified" as const, added: 0, removed: 3 }] }
    const isTestPath = testPathMatcher(ir)
    expect(removedTests(facts, isTestPath, OLD, HEAD)).toBeUndefined()
    expect(removedTests(facts, isTestPath, OLD, HEAD.filter((id) => !id.endsWith(".top")))).toEqual([".top"])
  })
})
