import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { convertJUnit } from "@gauntlet/sarif"
import { Effect, FileSystem } from "effect"
import type { GateImpl, SuiteImpl } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// The suite measures coverage in the same run as the tests; its reruns don't.
// A timing test that fails only while coverage is measured passes when run
// again alone, and is reported as slowed by coverage, not as flaky, so it
// doesn't ask a person to look. One that fails without coverage too still fails.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const junit = (failing: boolean) =>
  `<testsuite name="unit"><testcase classname="svc.TimingTest" name="fast" file="src/test/TimingTest.kt">${failing ? `<failure message="p99 took 31ms, over 20ms"/>` : ""}</testcase><testcase classname="svc.AppTest" name="adds" file="src/test/AppTest.kt"/></testsuite>`

// Fails while coverage is measured; `always` fails it without coverage too.
const timingSuite = (always: boolean): SuiteImpl => (_s, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const xml = junit(ctx.withCoverage === true || always)
    yield* fs.writeFileString(`${ctx.outputDir}/TEST-unit.xml`, xml).pipe(Effect.orDie)
    if (ctx.withCoverage) yield* fs.writeFileString(`${ctx.outputDir}/coverage.json`, `{"value": 91}`).pipe(Effect.orDie)
    const report = yield* convertJUnit("unit", [{ path: "TEST-unit.xml", content: xml }]).pipe(Effect.orDie)
    return { command: ["test"], exitCode: 0, runs: [report.run], tests: { counts: report.counts, ids: report.tests.map((t) => t.id) } }
  })
const coverage: GateImpl = (_check, ctx) =>
  Effect.gen(function*() {
    const file = (yield* ctx.collect).find((f) => f.path === "coverage.json")
    const value = file ? (JSON.parse(file.content) as { value: number }).value : 0
    return { command: ["coverage"], exitCode: 0, runs: [], metrics: { coverage: { value, unit: "%" as const, higherIsBetter: true } } }
  })
const packs = (always: boolean) => [{ ...scriptPack, reruns: true, suiteWithCoverage: true, runSuite: timingSuite(always), gates: { ...scriptPack.gates, coverage } }]

const check = async (always: boolean) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n", "src/test/TimingTest.kt": "class TimingTest\n" })
  s.r.commit("change")
  const out = join(s.r.dir, "out")
  await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", out, "--no-record"], packs(always))
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return { report, unit: report.checks.find((c: { check: string }) => c.check === "unit") }
}

describe("a timing test slowed by measuring coverage", () => {
  test("passes, is named as slowed by coverage, and isn't called flaky", async () => {
    const { report, unit } = await check(false)
    expect(unit.status).toBe("passed")
    expect(unit.reason).toContain("1 failure passed when run again alone without measuring coverage (slowed by coverage, as timing tests are): svc.TimingTest.fast")
    expect(unit.flaky).toBeUndefined()
    expect(JSON.stringify(report.decision)).not.toContain("flaky")
  })

  test("one that fails without coverage too still fails", async () => {
    const { unit } = await check(true)
    expect(unit.status).toBe("failed")
    expect(unit.failures).toEqual(["svc.TimingTest.fast: p99 took 31ms, over 20ms"])
  })
})
