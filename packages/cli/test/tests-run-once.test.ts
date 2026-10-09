import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import type { GateImpl, SuiteImpl } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Tests run once per check: the suite measures coverage in the same run, and
// the coverage gate reads it instead of running the tests again.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// The script pack, with a suite that writes coverage when asked, and a coverage gate that says whether it ran the tests.
const suite: SuiteImpl = (s, ctx, subset) =>
  Effect.gen(function*() {
    const r = yield* scriptPack.runSuite!(s, ctx, subset)
    if (ctx.withCoverage) yield* (yield* FileSystem.FileSystem).writeFileString(`${ctx.outputDir}/coverage.json`, `{"value": 91}`).pipe(Effect.orDie)
    return r
  })
const coverage: GateImpl = (check, ctx) =>
  Effect.gen(function*() {
    if (!ctx.coverageFromSuite) return { command: ["ran the tests again"], exitCode: 0, runs: [], metrics: { coverage: { value: 0, unit: "%" as const, higherIsBetter: true } } }
    const file = (yield* ctx.collect).find((f) => f.path === "coverage.json")!
    return { command: ["read the suite's run"], exitCode: 0, runs: [], metrics: { coverage: { value: (JSON.parse(file.content) as { value: number }).value, unit: "%" as const, higherIsBetter: true } } }
  })
const pack = [{ ...scriptPack, suiteWithCoverage: true, runSuite: suite, gates: { ...scriptPack.gates, coverage } }]

describe("tests run once per check", () => {
  test("the coverage gate reads the suite's run instead of running the tests again", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    s.r.commit("change")
    const out = join(s.r.dir, "out")
    await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", out, "--no-record"], pack)
    const cov = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "coverage")
    expect(cov.status).toBe("passed")
    expect(cov.proof.command).toEqual(["read the suite's run"])
  })
})
