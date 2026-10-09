import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { convertJUnit } from "@gauntlet/sarif"
import { Effect } from "effect"
import type { SuiteImpl } from "../../core/src/index.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// ADR 0024: what the project's own CI already ran isn't run again. Its tests
// and build are read from its reports, unless the change could have shaped
// them (it edits the CI's workflows or protected build files) or a report is a
// file in the repository.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// The script pack, taught to read CI's JUnit (target/test-reports/) instead of running scripts/test.sh.
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

const FAILING = `<testsuite name="unit"><testcase classname="svc.RoundTest" name="round"><failure message="1.5 rounded to 1"/></testcase></testsuite>`

const setup = () => {
  const s = baseRepo()
  repos.push(s.r)
  // The tests and the build would fail if Gauntlet ran them: it mustn't, when CI already did.
  s.r.git("checkout", "-q", "main")
  s.r.write({ "scripts/build.sh": "exit 1\n", "scripts/test.sh": "exit 1\n" })
  const base = s.r.commit("CI builds and tests this")
  s.r.git("checkout", "-q", "-b", "change")
  return { r: s.r, base }
}
const reports = (r: TempRepo) => {
  const dir = join(r.dir, ".git", "ci-reports", "gauntlet-reports-build", "target", "test-reports")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "TEST-svc.RoundTest.xml"), FAILING)
  return join(r.dir, ".git", "ci-reports")
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record", "--ci-reports", reports(r), "--ci-source", "https://ci.example/run/7"], readsCi)
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return (name: string) => report.checks.find((c: { check: string }) => c.check === name)
}

describe("reusing the CI's run", () => {
  test("the tests and the build are read from the CI's reports, never run again", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("change")
    const of = await check(r, base)
    expect(of("build")).toMatchObject({ status: "passed" })
    expect(of("build").proof.command).toEqual(["ci", "https://ci.example/run/7"])
    expect(of("unit")).toMatchObject({ status: "failed", failures: ["svc.RoundTest.round: 1.5 rounded to 1"] })
    expect(of("unit").proof.command).toEqual(["ci", "https://ci.example/run/7"])
  })

  test("a change to protected build files could shape the CI's run, so Gauntlet runs things itself", async () => {
    const { r, base } = setup()
    r.write({ "scripts/lint.sh": "cp lint.sarif \"$1/lint.sarif\" # tweaked\n" })
    r.commit("tweak a build script")
    const of = await check(r, base)
    expect(of("build").proof.command).not.toContain("ci")
  })

  test("a report committed to the repository is never trusted", async () => {
    const { r, base } = setup()
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": FAILING, "src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("plant a report")
    const out = join(r.dir, "out")
    // Only the planted file, under its repository path: nothing from the CI.
    const dir = join(r.dir, ".git", "planted", "a", "target", "test-reports")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "TEST-svc.RoundTest.xml"), FAILING)
    await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record", "--ci-reports", join(r.dir, ".git", "planted")], readsCi)
    // Gauntlet built it itself (and the build script fails), rather than take the planted report.
    const build = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "build")
    expect(build).toMatchObject({ status: "failed" })
    expect(build.proof.command[0]).not.toBe("ci")
  })
})

describe("reusing a local run", () => {
  const PASSING = `<testsuite name="unit"><testcase classname="svc.RoundTest" name="round"/></testsuite>`
  const working = async (r: TempRepo) => {
    const out = join(r.dir, "out")
    await cli(["check", "--repo", r.dir, "--working-tree", "--out", out, "--no-record"], readsCi)
    return JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "unit")
  }
  const local = () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.git("checkout", "-q", "main")
    s.r.write({ ".gitignore": "target/\nout/\n" })
    s.r.commit("ignore build output")
    s.r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    return s.r
  }

  test("tests run here after the last edit aren't run again", async () => {
    const r = local()
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": PASSING })
    const unit = await working(r)
    expect(unit.status).toBe("passed")
    expect(unit.proof.command).toEqual(["ci", "your local run"])
  })

  test("a report older than the last edit is stale, so the tests run", async () => {
    const r = local()
    r.write({ "target/test-reports/TEST-svc.RoundTest.xml": PASSING })
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(join(r.dir, "target/test-reports/TEST-svc.RoundTest.xml"), old, old)
    const unit = await working(r)
    expect(unit.proof.command[0]).not.toBe("ci")
  })
})
