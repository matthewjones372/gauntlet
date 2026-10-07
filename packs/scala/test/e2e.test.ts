import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { scalaPack } from "../src/index.ts"

// End to end with real sbt: a full ScalaTest service through every gate
// (scalafix, scoverage, Stryker4s) and the selftest, and a small project per
// other framework (munit, munit-cats-effect, ZIO Test, weaver) checking that
// its tests are counted, a failure is named and a skip is caught. Opt in with
// GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURES = join(import.meta.dir, "..", "..", "..", "examples", "fixtures")
const TIMEOUT = 20 * 60 * 1000
const IGNORED = /\/(target|project\/target|project\/project|\.bsp)(\/|$)/
const scala = (args: string[]) => cli(args, [scalaPack])

const project = (fixture: string) => {
  const repo = new TempRepo()
  cpSync(join(FIXTURES, fixture), repo.dir, { recursive: true, filter: (src) => !IGNORED.test(src) })
  return repo
}

const checkOn = async (repo: TempRepo, base: string, name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await scala(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const status = (c: string) => report.checks.find((x: { check: string }) => x.check === c)?.status
  return { code: res.code, report, status }
}

describe.skipIf(!E2E)("Scala pack end to end (real sbt, ScalaTest service)", () => {
  let repo: TempRepo
  let base = ""
  const read = (p: string) => readFileSync(join(FIXTURES, "scala-service", p), "utf8")
  const scenario = (name: string, files: Record<string, string>) => {
    repo.git("checkout", "-q", "-B", name, base)
    repo.write(files)
    repo.commit(name)
  }
  const check = (name: string) => checkOn(repo, base, name)

  beforeAll(async () => {
    repo = project("scala-service")
    repo.commit("trunk")
    const recorded = await scala(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers scalafix's finding and records mutation and tests", () => {
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "scalafix").results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["DisableSyntax.var"])
    expect(Object.keys(b.runs[0].properties.gauntlet.metrics.mutation.perFile)).toContain("src/main/scala/svc/domain/Money.scala")
    expect(b.runs[0].properties.gauntlet.testIds).toHaveLength(4)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "src/main/scala/svc/domain/Money.scala": `${read("src/main/scala/svc/domain/Money.scala")}\n  def negate(m: Money): Money = Money(-m.minor, m.currency)\n`,
      "src/test/scala/svc/domain/NegateSpec.scala": "package svc.domain\n\nimport org.scalatest.funsuite.AnyFunSuite\n\nclass NegateSpec extends AnyFunSuite:\n  test(\"negates\") {\n    assert(Money.negate(Money(5, \"EUR\")) == Money(-5, \"EUR\"))\n  }\n",
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a compile error fails the build", async () => {
    scenario("compile-error", { "src/main/scala/svc/infra/Ledger.scala": `${read("src/main/scala/svc/infra/Ledger.scala")}\n  val broken: Int = "nope"\n` })
    expect((await check("compile-error")).status("build")).toBe("failed")
  }, TIMEOUT)

  test("3. a change that breaks a test fails the unit gate, and names the test", async () => {
    scenario("broken", { "src/main/scala/svc/settlement/Fx.scala": read("src/main/scala/svc/settlement/Fx.scala").replace("/ 10_000", "/ 1_000") })
    const r = await check("broken")
    const unit = r.report.checks.find((c: { check: string }) => c.check === "unit")
    expect(unit.status).toBe("failed")
    expect(unit.failures[0]).toStartWith("svc.settlement.FxSpec.converts")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. weakening a protected test: base copy runs, change is forbidden", async () => {
    scenario("weakened", {
      "src/test/scala/svc/domain/MoneySpec.scala": read("src/test/scala/svc/domain/MoneySpec.scala")
        .replace("test(\"refuses mixed currencies\")", "ignore(\"refuses mixed currencies\")")
        .replace("    assert(!Money.isPositive(Money(0, \"EUR\")))\n", ""),
    })
    const r = await check("weakened")
    const found = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("new-skips")
    expect(found).toContain("weakened-assertions")
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("5. a grandfathered finding survives a line shift; a new one fails", async () => {
    scenario("shift", { "src/main/scala/svc/infra/Ledger.scala": read("src/main/scala/svc/infra/Ledger.scala").replace("package svc.infra\n", "package svc.infra\n\n// The ledger keeps balances.\n") })
    expect((await check("shift")).status("lint")).toBe("passed")
    scenario("new-finding", { "src/main/scala/svc/infra/Ledger.scala": `${read("src/main/scala/svc/infra/Ledger.scala")}\n  def count(entries: List[Money]): Int =\n    var n = 0\n    entries.foreach(_ => n += 1)\n    n\n` })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("DisableSyntax.var")
  }, TIMEOUT)

  test("6. domain importing infra breaks the arch rule", async () => {
    scenario("arch", { "src/main/scala/svc/domain/Audit.scala": "package svc.domain\n\nimport svc.infra.Ledger\n\nobject Audit:\n  val total = Ledger.total\n" })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations.find((v: { ruleId: string }) => v.ruleId.startsWith("arch/")).message).toBe("domain imports svc.infra.Ledger, which belongs to infra.")
  }, TIMEOUT)

  test("7. a throw in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("zone-throw", { "src/main/scala/svc/settlement/Fx.scala": `${read("src/main/scala/svc/settlement/Fx.scala")}\n  def requireRate(rate: Long): Long =\n    if rate <= 0 then throw new IllegalArgumentException("rate must be positive") else rate\n` })
    const r = await check("zone-throw")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("scala.no-throw")
    expect(r.report.decision.tier).toBe("owner")
  }, TIMEOUT)

  test("8. a test exiting the JVM and main code importing the test framework are forbidden", async () => {
    scenario("cheats", {
      "src/test/scala/svc/domain/ExitSpec.scala": "package svc.domain\n\nimport org.scalatest.funsuite.AnyFunSuite\n\nclass ExitSpec extends AnyFunSuite:\n  test(\"leaves\") {\n    assert(Money.isPositive(Money(1, \"EUR\")))\n    sys.exit(0)\n  }\n",
      "src/main/scala/svc/infra/Strict.scala": "package svc.infra\n\nimport org.scalatest.Assertions\n\nobject Strict:\n  val on = true\n",
    })
    const found = (await check("cheats")).report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("exit-in-tests")
    expect(found).toContain("test-refs-in-main")
  }, TIMEOUT)

  test("9. untested changed code fails coverage on changed lines", async () => {
    scenario("uncovered", { "src/main/scala/svc/infra/AuditLog.scala": "package svc.infra\n\nobject AuditLog:\n  def describe(minor: Long, currency: String): String =\n    if minor > 0 then s\"+$minor $currency\" else s\"$minor $currency\"\n" })
    expect((await check("uncovered")).status("coverage")).toBe("failed")
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await scala(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, TIMEOUT)
})

const FRAMEWORKS = [
  { name: "munit", test: "src/test/scala/calc/CalcSuite.scala", suite: "calc.CalcSuite", withSkip: (t: string) => t.replace("test(\"adds\")", "test(\"adds\".ignore)") },
  { name: "munit-cats-effect", test: "src/test/scala/calc/CalcSuite.scala", suite: "calc.CalcSuite", withSkip: (t: string) => t.replace("test(\"adds\")", "test(\"adds\".ignore)") },
  { name: "zio-test", test: "src/test/scala/calc/CalcSpec.scala", suite: "calc.CalcSpec", withSkip: (t: string) => t.replace("      assertTrue(Calc.add(1, 2) == 3)\n    },", "      assertTrue(Calc.add(1, 2) == 3)\n    } @@ TestAspect.ignore,") },
  { name: "weaver", test: "src/test/scala/calc/CalcSuite.scala", suite: "calc.CalcSuite", withSkip: (t: string) => t.replace("pureTest(\"adds\")", "pureTest(\"adds\".ignore)") },
] as const

for (const fw of FRAMEWORKS) {
  describe.skipIf(!E2E)(`Scala pack end to end (real sbt, ${fw.name})`, () => {
    let repo: TempRepo
    let base = ""
    const read = (p: string) => readFileSync(join(FIXTURES, "scala-frameworks", fw.name, p), "utf8")

    beforeAll(() => {
      repo = project(join("scala-frameworks", fw.name))
      base = repo.commit("trunk")
    })
    afterAll(() => repo?.cleanup())

    test("tests are counted, a failure is named, and a skip is caught", async () => {
      repo.git("checkout", "-q", "-B", "broken", base)
      repo.write({ "src/main/scala/calc/Calc.scala": read("src/main/scala/calc/Calc.scala").replace("a + b", "a + b + 1") })
      repo.commit("broken")
      const broken = await checkOn(repo, base, "broken")
      const unit = broken.report.checks.find((c: { check: string }) => c.check === "unit")
      expect(unit.status).toBe("failed")
      expect(unit.tests.executed).toBe(2)
      expect(unit.failures.join("\n")).toContain(fw.suite)

      repo.git("checkout", "-q", "-B", "skipped", base)
      repo.write({ [fw.test]: fw.withSkip(read(fw.test)) })
      repo.commit("skipped")
      const skipped = await checkOn(repo, base, "skipped")
      expect(skipped.report.integrity.findings.map((f: { check: string }) => f.check)).toContain("new-skips")
    }, TIMEOUT)
  })
}
