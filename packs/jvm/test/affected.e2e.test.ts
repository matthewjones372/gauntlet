import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { jvmPack } from "../src/index.ts"

// Running the tests a change affects (spec 0013), end to end against real
// Gradle, JUnit and JaCoCo on examples/fixtures/kotlin-service. Opt in with
// GAUNTLET_E2E=1, like the pack's other end-to-end tests; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "kotlin-service")
const TIMEOUT = 15 * 60 * 1000

const POLICY = `gauntlet "kotlin-service"
use jvm
mode enforce
owners @platform

protect {
  tests  "src/test/**"
  config "*.gradle.kts", "gradle/**"
}

suites { unit "src/test/**" affected }

integrity { ratchet executed tests }

gates {
  fast   { build }
  verify { unit, coverage >= 50% on changed }
}

review {
  review when protected changed
  auto   when all gates pass
}
`

let repo: TempRepo
let base = ""
const jvm = (args: string[]) => cli(args, [jvmPack])
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const check = async (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
  const out = join(repo.dir, ".git", `out-${name}`)
  await jvm(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const unit = report.checks.find((c: { check: string }) => c.check === "unit")
  return { report, unit, findings: report.integrity.findings.map((f: { check: string; kind: string }) => `${f.kind} ${f.check}`) }
}

describe.skipIf(!E2E)("an affected suite end to end (real Gradle)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin)(\/|$)/.test(src) })
    writeFileSync(join(repo.dir, ".gauntlet", "policy.gx"), POLICY)
    repo.commit("trunk")
    const recorded = await jvm(["baseline", "--repo", repo.dir, "--trunk", "main"])
    console.error("DIAG baseline", recorded.out, recorded.err)
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline maps what each test class executed", () => {
    const meta = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8")).runs[0].properties.gauntlet
    const files = (cls: string) => meta.testMap.tests[cls].map((i: number) => meta.testMap.files[i])
    expect(files("svc.domain.MoneyTest")).toEqual(["src/main/kotlin/svc/domain/Money.kt", "src/test/kotlin/svc/domain/MoneyTest.kt"])
    expect(files("svc.settlement.FxTest")).toEqual(["src/main/kotlin/svc/domain/Money.kt", "src/main/kotlin/svc/settlement/Fx.kt", "src/test/kotlin/svc/settlement/FxTest.kt"])
  })

  test("a change to Fx runs FxTest alone, and the tests left out aren't missing", async () => {
    const r = await check("fx", { "src/main/kotlin/svc/settlement/Fx.kt": read("src/main/kotlin/svc/settlement/Fx.kt").replace("/ 10_000", "/ 10000") })
    expect(r.unit.status).toBe("passed")
    expect(r.unit.selection).toMatchObject({ ran: 1, of: 4, deselected: ["svc.domain.MoneyTest"] })
    expect(r.findings).toEqual([])
    expect(r.report.decision.tier).toBe("auto")
  }, TIMEOUT)

  test("a change to code no test executed runs every test, and says why", async () => {
    const r = await check("ledger", { "src/main/kotlin/svc/infra/Ledger.kt": read("src/main/kotlin/svc/infra/Ledger.kt").replace("entries += amount", "entries.add(amount)") })
    expect(r.unit.selection).toMatchObject({ ran: 4, of: 4 })
    expect(r.unit.selection.why[0]).toContain("src/main/kotlin/svc/infra/Ledger.kt")
  }, TIMEOUT)

  test("a test removed from a selected class is still caught", async () => {
    const money = read("src/test/kotlin/svc/domain/MoneyTest.kt")
    const r = await check("dropped", {
      "src/main/kotlin/svc/settlement/Fx.kt": read("src/main/kotlin/svc/settlement/Fx.kt").replace("/ 10_000", "/ 10000"),
      "src/test/kotlin/svc/domain/MoneyTest.kt": `${money.slice(0, money.indexOf("    @Test\n    fun knowsWhenPositive"))}}\n`,
    })
    expect(r.findings).toContain("forbid deleted-tests")
    expect(r.findings).toContain("ratchet executed-tests")
  }, TIMEOUT)
})
