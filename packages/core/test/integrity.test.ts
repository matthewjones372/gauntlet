import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { type IntegrityDetector, type IntegrityInput, runIntegrity, testPathMatcher } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" }
gates { verify { unit } }
`)

const input = (over: Partial<IntegrityInput> = {}): IntegrityInput => ({
  ir,
  facts: noFacts(),
  readBase: () => Effect.succeed(Option.none()),
  readHead: () => Effect.succeed(Option.none()),
  isTestPath: testPathMatcher(ir),
  baselineMetrics: {},
  headFiles: ["src/test/money/FxTest.kt", "src/main/money/Fx.kt"],
  dir: "/nonexistent",
  ...over,
})

const run = (i: IntegrityInput, detectors: ReadonlyArray<IntegrityDetector> = []) => Effect.runSync(runIntegrity(i, detectors).pipe(Effect.provide(BunServices.layer)))
const counts = (executed: number, skipped = 0) => ({ executed, passed: executed, failed: 0, errored: 0, skipped })

describe("core integrity checks", () => {
  test("a deleted test file is forbidden", () => {
    const r = run(input({ facts: noFacts({ files: [{ path: "src/test/money/FxTest.kt", status: "deleted", added: 0, removed: 9 }] }) }))
    expect(r.findings.map((f) => `${f.kind} ${f.check} ${f.path}`)).toEqual(["forbid deleted-tests src/test/money/FxTest.kt"])
  })

  test("a test that ran at base and doesn't now is forbidden", () => {
    const r = run(input({ baseTestIds: ["a.B.one", "a.B.two"], headTests: { counts: counts(1), ids: ["a.B.one"] } }))
    expect(r.findings.filter((f) => f.check === "deleted-tests").map((f) => f.message)).toEqual(["Test a.B.two ran at base and no longer runs."])
  })

  test("main code naming a test class or test path is forbidden; test code may", () => {
    const facts = noFacts({
      addedLines: new Map([
        ["src/main/money/Fx.kt", [{ line: 3, text: "  if (caller == \"FxTest\") return 42" }, { line: 9, text: "  load(\"src/test/resources/x.json\")" }]],
        ["src/test/money/FxTest.kt", [{ line: 2, text: "  val fx = FxTest()" }]],
      ]),
    })
    const r = run(input({ facts }))
    expect(r.findings.map((f) => `${f.check} ${f.path}:${f.line}`)).toEqual([
      "test-refs-in-main src/main/money/Fx.kt:3",
      "test-refs-in-main src/main/money/Fx.kt:9",
    ])
  })

  test("comments about special-casing tests are flagged, ordinary mentions aren't", () => {
    const facts = noFacts({
      addedLines: new Map([["src/main/A.kt", [
        { line: 1, text: "  // only in tests: skip validation" },
        { line: 2, text: "  // hack for the tests" },
        { line: 3, text: "  // see the integration tests for usage" },
      ]]]),
    })
    expect(run(input({ facts })).findings.map((f) => `${f.kind} ${f.line}`)).toEqual(["flag 1", "flag 2"])
  })

  test("fewer executed tests than the baseline is a ratchet failure", () => {
    const r = run(input({
      baselineMetrics: { "integrity/executed-tests": { value: 120, unit: "count", higherIsBetter: true } },
      headTests: { counts: counts(80), ids: [] },
    }))
    expect(r.findings.map((f) => `${f.kind} ${f.check}`)).toEqual(["ratchet executed-tests"])
  })

  test("more skipped tests than the baseline is a ratchet failure", () => {
    const r = run(input({
      baselineMetrics: { "integrity/skipped-tests": { value: 1, unit: "count", higherIsBetter: false } },
      headTests: { counts: counts(10, 3), ids: [] },
    }))
    expect(r.findings.map((f) => f.check)).toEqual(["skipped-tests"])
  })

  test("checks with no detector or no data are not executed", () => {
    const r = run(input())
    expect(r.notExecuted).toContain("executed-tests")
    expect(r.notExecuted).toContain("weakened-assertions")
    expect(r.notExecuted).not.toContain("deleted-tests")
    expect(r.notExecuted).not.toContain("test-refs-in-main")
  })

  test("pack detectors cover their checks and report findings and ratchet values", () => {
    const detector: IntegrityDetector = {
      name: "kotlin",
      checks: ["weakened-assertions", "suppressions"],
      run: () => Effect.succeed({
        findings: [{ check: "weakened-assertions", kind: "forbid", message: "assertTrue(true)", path: "src/test/money/FxTest.kt", line: 4, detector: "kotlin" }],
        metrics: { "integrity/suppressions": { value: 3, unit: "count", higherIsBetter: false } },
      }),
    }
    const r = run(input({ baselineMetrics: { "integrity/suppressions": { value: 2, unit: "count", higherIsBetter: false } } }), [detector])
    expect(r.notExecuted).not.toContain("weakened-assertions")
    expect(r.findings.map((f) => `${f.kind} ${f.check}`)).toEqual(["forbid weakened-assertions", "ratchet suppressions"])
  })

  test("found by running Gauntlet on itself: broad suite globs, lockfiles and code aren't test references or comments", () => {
    const broad = compiled(`gauntlet "svc"
use jvm
owners @platform
suites { unit "packages/*/test/**" }
gates { verify { unit } }
`).ir
    const facts = noFacts({
      addedLines: new Map([
        ["packages/core/src/a.ts", [{ line: 1, text: 'import { x } from "packages/dsl"' }, { line: 2, text: 'const help = "only in tests"' }]],
        ["bun.lock", [{ line: 9, text: '"packages/core": { "name": "MoneyTest" }' }]],
        ["packages/core/src/b.ts", [{ line: 3, text: "  // only in tests: skip validation" }]],
      ]),
    })
    const r = run(input({ ir: broad, isTestPath: testPathMatcher(broad), facts }))
    expect(r.findings.map((f) => `${f.check} ${f.path}:${f.line}`)).toEqual(["test-special-case-comments packages/core/src/b.ts:3"])
  })
})

