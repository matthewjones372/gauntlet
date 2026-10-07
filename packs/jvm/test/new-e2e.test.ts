import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { jvmPack } from "../src/index.ts"

// `gauntlet new kotlin-service` end to end with real Gradle (PLAN M11): the
// generated project records a clean baseline and passes in enforce mode, and
// its strict policy blocks what it promises to. Opt in with GAUNTLET_E2E=1.

const E2E = process.env.GAUNTLET_E2E === "1"
const TIMEOUT = 15 * 60 * 1000
const MONEY = "src/main/kotlin/com/acme/payments/domain/Money.kt"

let repo: TempRepo
let base = ""
const jvm = (args: string[]) => cli(args, [jvmPack])

const scenario = (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
}

const check = async (name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await jvm(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  return { code: res.code, report: JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")) }
}

const money = () => readFileSync(join(repo.dir, MONEY), "utf8")

describe.skipIf(!E2E)("gauntlet new kotlin-service (real Gradle)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    // `new` wants an empty directory; TempRepo has already run git init there.
    rmSync(join(repo.dir, ".git"), { recursive: true, force: true })
    const created = await jvm(["new", "kotlin-service", repo.dir, "--name", "payments-api", "--owner", "@acme/payments", "--package", "com.acme.payments"])
    if (created.code !== 0) throw new Error(created.err)
    repo.git("config", "commit.gpgsign", "false")
    repo.commit("new project")
    const recorded = await jvm(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the generated project starts clean: no grandfathered findings, every file above the mutation floor", () => {
    const sarif = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(sarif.runs.flatMap((r: { results?: unknown[] }) => r.results ?? [])).toEqual([])
    const metrics = sarif.runs[0].properties.gauntlet.metrics
    expect(metrics["integrity/property-tests"].value).toBeGreaterThan(0)
    for (const score of Object.values(metrics.mutation.perFile as Record<string, number>)) expect(score).toBeGreaterThanOrEqual(80)
    for (const score of Object.values(metrics.coverage.perFile as Record<string, number>)) expect(score).toBeGreaterThanOrEqual(90)
  })

  test("a small, tested change passes in enforce mode and gets auto", async () => {
    scenario("clean", {
      [MONEY]: money().replace("    fun isPositive(): Boolean = minor > 0\n", "    fun isPositive(): Boolean = minor > 0\n\n    fun isZero(): Boolean = minor == 0L\n"),
      "src/test/kotlin/com/acme/payments/domain/ZeroTest.kt": `package com.acme.payments.domain

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ZeroTest {
    private val eur = Currency.of("EUR")!!

    @Test
    fun knowsZero() {
        assertTrue(Money(0, eur).isZero())
        assertFalse(Money(1, eur).isZero())
        assertFalse(Money(-1, eur).isZero())
    }
}
`,
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("mutable state in the core is blocked", async () => {
    scenario("mutable", { [MONEY]: money().replace("    fun isPositive(): Boolean = minor > 0", "    fun isPositive(): Boolean {\n        var positive = minor > 0\n        return positive\n    }") })
    const r = await check("mutable")
    expect(r.code).toBe(1)
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("kotlin.no-var")
  }, TIMEOUT)

  test("the domain importing infrastructure is blocked", async () => {
    scenario("layering", { "src/main/kotlin/com/acme/payments/domain/Audit.kt": "package com.acme.payments.domain\n\nimport com.acme.payments.infra.InMemoryLedger\n\nfun audit(ledger: InMemoryLedger): InMemoryLedger = ledger\n" })
    const r = await check("layering")
    expect(r.code).toBe(1)
    expect(r.report.checks.find((c: { check: string }) => c.check === "arch").status).toBe("failed")
  }, TIMEOUT)
})
