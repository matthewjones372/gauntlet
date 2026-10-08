import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { jvmPack } from "../../jvm/src/index.ts"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { scalaPack } from "../src/index.ts"

// ADR 0022 end to end with real Gradle and sbt: the Kotlin service in ledger/
// and the Scala service in checks/, one repository, nothing at its root.
// Opt in with GAUNTLET_E2E=1; CI runs it as its own shard.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURES = join(import.meta.dir, "..", "..", "..", "examples", "fixtures")
const TIMEOUT = 25 * 60 * 1000
const IGNORED = /\/(build|\.gradle|\.kotlin|target|project\/target|project\/project|\.bsp|\.gauntlet)(\/|$)/
const run = (args: string[]) => cli(args, [jvmPack, scalaPack])

const POLICY = `gauntlet "street"
use jvm in "ledger", scala in "checks"
mode enforce
owners @platform

protect {
  tests  "**/src/test/**"
  config "ledger/*.gradle.kts", "ledger/gradle/**", "checks/*.sbt"
}

suites { unit "src/test/**" }

gates {
  fast   { build, lint ratchet }
  verify { unit, coverage >= 50% on changed, mutation ratchet on changed }
}

review {
  review when protected changed
  auto   when all gates pass
}
`

describe.skipIf(!E2E)("several builds end to end (real Gradle and sbt)", () => {
  let repo: TempRepo
  let base = ""
  const read = (fixture: string, p: string) => readFileSync(join(FIXTURES, fixture, p), "utf8")
  const scenario = (name: string, files: Record<string, string>) => {
    repo.git("checkout", "-q", "-B", name, base)
    repo.write(files)
    repo.commit(name)
  }
  const check = async (name: string) => {
    const out = join(repo.dir, ".git", `out-${name}`)
    const res = await run(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
    const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
    const of = (c: string) => report.checks.find((x: { check: string }) => x.check === c)
    return { code: res.code, report, of }
  }

  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(join(FIXTURES, "kotlin-service"), join(repo.dir, "ledger"), { recursive: true, filter: (src) => !IGNORED.test(src) })
    cpSync(join(FIXTURES, "scala-service"), join(repo.dir, "checks"), { recursive: true, filter: (src) => !IGNORED.test(src) })
    repo.write({ "README.md": "street\n" })
    repo.commit("two builds")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("setup finds both builds and drafts a policy that names their folders", async () => {
    const draft = await run(["init", "--repo", repo.dir, "--template", "--dry-run", "--owner", "@platform"])
    expect(draft.code).toBe(0)
    expect(draft.out).toMatch(/^use (jvm in "ledger", scala in "checks"|scala in "checks", jvm in "ledger")$/m)
  }, TIMEOUT)

  test("the baseline runs every build and records their tests and files from the root", async () => {
    repo.write({ ".gauntlet/policy.gx": POLICY })
    repo.commit("policy")
    const recorded = await run(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    const props = b.runs[0].properties.gauntlet
    expect(props.testIds.some((id: string) => id.includes("MoneyTest"))).toBe(true)
    expect(props.testIds.some((id: string) => id.includes("MoneySpec"))).toBe(true)
    const files = Object.keys(props.metrics.coverage.perFile)
    expect(files.some((f) => f.startsWith("ledger/src/main/kotlin/"))).toBe(true)
    expect(files.some((f) => f.startsWith("checks/src/main/scala/"))).toBe(true)
  }, TIMEOUT)

  test("a tested change in one build passes, and the scoped checks run only there", async () => {
    scenario("clean", {
      "checks/src/main/scala/svc/domain/Money.scala": `${read("scala-service", "src/main/scala/svc/domain/Money.scala")}\n  def negate(m: Money): Money = Money(-m.minor, m.currency)\n`,
      "checks/src/test/scala/svc/domain/NegateSpec.scala": "package svc.domain\n\nimport org.scalatest.funsuite.AnyFunSuite\n\nclass NegateSpec extends AnyFunSuite:\n  test(\"negates\") {\n    assert(Money.negate(Money(5, \"EUR\")) == Money(-5, \"EUR\"))\n  }\n",
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.of("unit").proof.command).toEqual(expect.arrayContaining(["[ledger]", "[checks]"]))
    expect(r.of("coverage").proof.command).toContain("[checks]")
    expect(r.of("coverage").proof.command).not.toContain("[ledger]")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("a change that breaks the Kotlin build's test fails the suite and names it", async () => {
    scenario("broken", { "ledger/src/main/kotlin/svc/settlement/Fx.kt": read("kotlin-service", "src/main/kotlin/svc/settlement/Fx.kt").replace("/ 10_000", "/ 1_000") })
    const r = await check("broken")
    expect(r.of("unit").status).toBe("failed")
    expect(r.of("unit").failures.join("\n")).toContain("FxTest")
    expect(r.code).toBe(1)
  }, TIMEOUT)
})
