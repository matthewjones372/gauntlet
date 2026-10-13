import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { convertJUnit } from "@gauntlet/sarif"
import { Effect } from "effect"
import type { SuiteImpl } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// ADR 0024 reads a local run's reports instead of running the tests again. A
// narrow run (`./gradlew :domain:test`, `--tests 'one.Spec'`) leaves reports
// for only some of the tests, and those aren't the suite's run: the tests it
// left out didn't stop running. Gauntlet runs the suite itself instead.
// Each test records a baseline and runs full checks, hence the longer timeouts.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// The script pack, taught to read a local run's JUnit (target/test-reports/) instead of running scripts/test.sh.
const suite: SuiteImpl = (s, ctx, subset) =>
  ctx.fromCi
    ? Effect.gen(function*() {
      const xml = (yield* ctx.collect).filter((f) => /target\/test-reports\/.*\.xml$/.test(f.path))
      if (xml.length === 0) return { command: ["ci"], exitCode: 0, runs: [] }
      const r = yield* Effect.orDie(convertJUnit(s.name, xml))
      return { command: ["ci"], exitCode: 0, runs: [r.run], tests: { counts: r.counts, ids: r.tests.map((t) => t.id) } }
    })
    : scriptPack.runSuite!(s, ctx, subset)
const readsCi = [{ ...scriptPack, readsCi: true, runSuite: suite }]

const ROUND = `<testsuite name="unit"><testcase classname="svc.RoundTest" name="round"/></testsuite>`
const ADD = `<testsuite name="unit"><testcase classname="svc.AddTest" name="add"/></testsuite>`
const ROUND_FAILS = `<testsuite name="unit"><testcase classname="svc.RoundTest" name="round"><failure message="1.5 rounded to 1"/></testcase></testsuite>`

/** A repository whose baseline ran svc.AddTest.add and svc.RoundTest.round, with an edit in the working tree. */
const setup = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gitignore": "target/\nout/\n" })
  s.r.commit("ignore build output")
  expect((await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])).code).toBe(0)
  s.r.commit("baseline")
  s.r.git("checkout", "-q", "-b", "change")
  s.r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
  return s.r
}

const working = async (r: TempRepo) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--working-tree", "--out", out, "--no-record"], readsCi)
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return {
    code: res.code,
    unit: report.checks.find((c: { check: string }) => c.check === "unit"),
    findings: report.integrity.findings as ReadonlyArray<{ check: string; kind: string; message: string }>,
  }
}

describe("a local run of only some of the tests", () => {
  test("isn't taken for the suite's run: Gauntlet runs the suite, and no test is said to have stopped running", async () => {
    const r = await setup()
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": ROUND })
    const { code, unit, findings } = await working(r)
    expect(unit.proof.command[0]).not.toBe("ci")
    expect(unit).toMatchObject({ status: "passed", tests: { executed: 2 } })
    expect(findings.filter((f) => f.check === "deleted-tests" || f.check === "executed-tests")).toEqual([])
    expect(code).toBe(0)
  }, 60_000)

  test("a local run of every test the base ran is still read, not run again", async () => {
    const r = await setup()
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": ROUND, "target/test-reports/TEST-svc.AddTest.xml": ADD })
    const { unit, findings } = await working(r)
    expect(unit.proof.command).toEqual(["ci", "your local run"])
    expect(findings.filter((f) => f.check === "deleted-tests")).toEqual([])
  }, 60_000)

  test("a test whose source was deleted is still reported as no longer running", async () => {
    const r = await setup()
    rmSync(join(r.dir, "src/test/AddTest.txt"))
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": ROUND })
    const { code, unit, findings } = await working(r)
    expect(unit.proof.command[0]).not.toBe("ci")
    expect(findings.filter((f) => f.check === "deleted-tests" && f.kind === "forbid").map((f) => f.message)).toEqual(expect.arrayContaining([
      "Test svc.AddTest.add ran at base and no longer runs.",
    ]))
    expect(code).toBe(1)
  }, 60_000)
})

describe("a repeat check of the same tree", () => {
  test("judges a new local run again rather than reusing the last report", async () => {
    const r = await setup()
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": ROUND_FAILS, "target/test-reports/TEST-svc.AddTest.xml": ADD })
    const first = await working(r)
    expect(first.unit.status).toBe("failed")
    // The tests run again here, on the same tree, and pass.
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": ROUND })
    const second = await working(r)
    expect(second.unit).toMatchObject({ status: "passed" })
    expect(second.unit.proof.command).toEqual(["ci", "your local run"])
  }, 60_000)
})
