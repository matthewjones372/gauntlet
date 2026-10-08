import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { jvmPack } from "../src/index.ts"

// End-to-end against real Gradle on examples/fixtures/kotlin-service (PLAN
// section 20). Slow: every check runs Gradle several times in a fresh
// process. Opt in with GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "kotlin-service")
const TIMEOUT = 15 * 60 * 1000

const POLICY = readFileSync(join(FIXTURE, ".gauntlet", "policy.gx"), "utf8")

let repo: TempRepo
let base = ""
const jvm = (args: string[]) => cli(args, [jvmPack])

/** Starts a scenario branch from the trunk commit that has the baseline. */
const scenario = (name: string, files: Record<string, string>, remove: string[] = []) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files).remove(...remove)
  repo.commit(name)
}

const check = async (name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await jvm(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const status = (c: string) => report.checks.find((x: { check: string }) => x.check === c)?.status
  return { code: res.code, report, status, out: res.out }
}

const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

describe.skipIf(!E2E)("JVM pack end to end (real Gradle)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin)(\/|$)/.test(src) })
    writeFileSync(join(repo.dir, ".gauntlet", "policy.gx"), POLICY)
    repo.commit("trunk")
    const recorded = await jvm(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers detekt's existing findings and records mutation per file", () => {
    const meta = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    const detekt = meta.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "detekt")
    expect(detekt.results.length).toBe(2)
    expect(meta.runs[0].properties.gauntlet.metrics.mutation.perFile["src/main/kotlin/svc/domain/Money.kt"]).toBeGreaterThan(0)
    expect(meta.runs[0].properties.gauntlet.testIds.length).toBe(4)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "src/main/kotlin/svc/domain/Money.kt": read("src/main/kotlin/svc/domain/Money.kt").replace(
        "    fun isPositive(): Boolean = minor > 0",
        "    fun isPositive(): Boolean = minor > 0\n\n    fun negate(): Money = Money(-minor, currency)",
      ),
      "src/test/kotlin/svc/domain/NegateTest.kt": `package svc.domain\n\nimport kotlin.test.Test\nimport kotlin.test.assertEquals\n\nclass NegateTest {\n    @Test\n    fun negates() {\n        assertEquals(Money(-5, "EUR"), Money(5, "EUR").negate())\n    }\n}\n`,
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a change that breaks a test fails the unit gate", async () => {
    scenario("broken", { "src/main/kotlin/svc/settlement/Fx.kt": read("src/main/kotlin/svc/settlement/Fx.kt").replace("/ 10_000", "/ 1_000") })
    const r = await check("broken")
    expect(r.status("unit")).toBe("failed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("3. weakening a protected test: base copy runs, change is forbidden", async () => {
    scenario("weakened", {
      "src/test/kotlin/svc/domain/MoneyTest.kt": read("src/test/kotlin/svc/domain/MoneyTest.kt")
        .replace("        assertFalse(Money(0, \"EUR\").isPositive())\n", "")
        .replace("    @Test\n    fun refusesMixedCurrencies", "    @kotlin.test.Ignore\n    @Test\n    fun refusesMixedCurrencies"),
    })
    const r = await check("weakened")
    const findings = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(findings).toContain("weakened-assertions")
    expect(findings).toContain("new-skips")
    expect(r.report.facts.protectedTouched.map((p: { action: string }) => p.action)).toEqual(["edited"])
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. a grandfathered finding survives a line shift; a new one fails", async () => {
    const ledger = read("src/main/kotlin/svc/infra/Ledger.kt")
    scenario("shift", { "src/main/kotlin/svc/infra/Ledger.kt": ledger.replace("package svc.infra\n", "package svc.infra\n\n// The ledger keeps every recorded amount.\n") })
    expect((await check("shift")).status("lint")).toBe("passed")
    // detekt ignores magic numbers in property declarations, so this one is in a function.
    scenario("new-finding", { "src/main/kotlin/svc/infra/Ledger.kt": ledger.replace("class Ledger {", "class Ledger {\n    fun capacity(): Int = entries.size * 37\n") })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("detekt.style.MagicNumber")
  }, TIMEOUT)

  test("5. domain importing infra breaks the arch rule", async () => {
    scenario("arch", {
      "src/main/kotlin/svc/domain/Audit.kt": "package svc.domain\n\nimport svc.infra.Ledger\n\nclass Audit(private val ledger: Ledger)\n",
    })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations[0].message).toBe("domain imports svc.infra.Ledger, which belongs to infra.")
  }, TIMEOUT)

  test("6. runCatching in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("run-catching", {
      "src/main/kotlin/svc/settlement/Fx.kt": read("src/main/kotlin/svc/settlement/Fx.kt").replace(
        "    fun convert(amount: Money): Money = Money(amount.minor * rateBasisPoints / 10_000, target)",
        "    fun convert(amount: Money): Money = Money(amount.minor * rateBasisPoints / 10_000, target)\n\n    fun tryConvert(amount: Money): Money? = runCatching { convert(amount) }.getOrNull()",
      ),
    })
    const r = await check("run-catching")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("kotlin.no-run-catching")
    expect(r.report.decision.tier).toBe("owner")
    expect(r.report.decision.owners).toEqual(["@payments"])
  }, TIMEOUT)

  test("7. a test exiting the process and main code naming a test class are forbidden", async () => {
    scenario("cheats", {
      "src/test/kotlin/svc/domain/ExitTest.kt": "package svc.domain\n\nimport kotlin.system.exitProcess\nimport kotlin.test.Test\n\nclass ExitTest {\n    @Test\n    fun leaves() {\n        exitProcess(0)\n    }\n}\n",
      "src/main/kotlin/svc/infra/Ledger.kt": read("src/main/kotlin/svc/infra/Ledger.kt").replace(
        "    fun record(amount: Money) {",
        "    fun record(amount: Money) {\n        if (Thread.currentThread().stackTrace.any { it.className.contains(\"MoneyTest\") }) return",
      ),
    })
    const r = await check("cheats")
    const findings = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(findings).toContain("exit-in-tests")
    expect(findings).toContain("test-refs-in-main")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("8. untested changed code fails coverage on changed lines", async () => {
    scenario("uncovered", {
      "src/main/kotlin/svc/infra/Ledger.kt": read("src/main/kotlin/svc/infra/Ledger.kt").replace(
        "class Ledger {",
        "class Ledger {\n    fun size(): Int = entries.size\n\n    fun isEmpty(): Boolean = entries.isEmpty()\n",
      ),
    })
    const r = await check("uncovered")
    expect(r.status("coverage")).toBe("failed")
    expect(r.report.checks.find((c: { check: string }) => c.check === "coverage").reason).toContain("doesn't meet >= 50%")
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await jvm(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, 60 * 60 * 1000)
})
