import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { goPack } from "../src/index.ts"

// End to end on examples/fixtures/go-service with the real tools: go build,
// go test -json, -coverprofile, golangci-lint and gremlins. Opt in with
// GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "go-service")
const TIMEOUT = 10 * 60 * 1000

let repo: TempRepo
let base = ""
const go = (args: string[]) => cli(args, [goPack])
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const scenario = (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
}

const check = async (name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await go(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const status = (c: string) => report.checks.find((x: { check: string }) => x.check === c)?.status
  return { code: res.code, report, status }
}

describe.skipIf(!E2E)("Go pack end to end (real tools)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true })
    repo.commit("trunk")
    const recorded = await go(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers staticcheck's finding and records mutation and tests", () => {
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "golangci-lint").results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["staticcheck"])
    expect(Object.keys(b.runs[0].properties.gauntlet.metrics.mutation.perFile)).toContain("domain/money.go")
    expect(b.runs[0].properties.gauntlet.testIds).toHaveLength(4)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "domain/money.go": `${read("domain/money.go")}\n// Negate flips the sign.\nfunc Negate(m Money) Money { return Money{Minor: -m.Minor, Currency: m.Currency} }\n`,
      "domain/negate_test.go": "package domain\n\nimport \"testing\"\n\nfunc TestNegates(t *testing.T) {\n\tif got := Negate(Money{5, \"EUR\"}); got != (Money{-5, \"EUR\"}) {\n\t\tt.Errorf(\"got %v\", got)\n\t}\n}\n",
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a compile error fails the build", async () => {
    scenario("compile-error", { "infra/ledger.go": `${read("infra/ledger.go")}\nvar broken int = "nope"\n` })
    expect((await check("compile-error")).status("build")).toBe("failed")
  }, TIMEOUT)

  test("3. a change that breaks a test fails the unit gate, and names the test", async () => {
    scenario("broken", { "settlement/fx.go": read("settlement/fx.go").replace("/ 10_000", "/ 1_000") })
    const r = await check("broken")
    const unit = r.report.checks.find((c: { check: string }) => c.check === "unit")
    expect(unit.status).toBe("failed")
    expect(unit.failures[0]).toStartWith("example.com/svc/settlement.TestConverts: got")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. weakening a protected test: base copy runs, change is forbidden", async () => {
    scenario("weakened", {
      "domain/money_test.go": read("domain/money_test.go")
        .replace("func TestRefusesMixedCurrencies(t *testing.T) {", "func TestRefusesMixedCurrencies(t *testing.T) {\n\tt.Skip(\"later\")")
        .replace("\tif IsPositive(Money{0, \"EUR\"}) {\n\t\tt.Error(\"0 isn't positive\")\n\t}\n", ""),
    })
    const r = await check("weakened")
    const found = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("new-skips")
    expect(found).toContain("weakened-assertions")
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("5. a grandfathered finding survives a line shift; a new one fails", async () => {
    scenario("shift", { "infra/ledger.go": read("infra/ledger.go").replace("package infra\n", "package infra\n\n// The ledger keeps balances.\n") })
    expect((await check("shift")).status("lint")).toBe("passed")
    scenario("new-finding", { "infra/ledger.go": `${read("infra/ledger.go").replace("import \"example.com/svc/domain\"", "import (\n\t\"os\"\n\n\t\"example.com/svc/domain\"\n)")}\n// Drop removes a file.\nfunc Drop(p string) { os.Remove(p) }\n` })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("errcheck")
  }, TIMEOUT)

  test("6. domain importing infra breaks the arch rule", async () => {
    scenario("arch", { "domain/audit.go": "package domain\n\nimport \"example.com/svc/infra\"\n\n// Audit totals.\nvar Audit = infra.Total\n" })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations.find((v: { ruleId: string }) => v.ruleId.startsWith("arch/")).message).toBe("domain imports example.com/svc/infra, which belongs to infra.")
  }, TIMEOUT)

  test("7. a panic in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("zone-panic", { "settlement/fx.go": `${read("settlement/fx.go")}\n// RequireRate checks a rate.\nfunc RequireRate(rate int64) int64 {\n\tif rate <= 0 {\n\t\tpanic("rate must be positive")\n\t}\n\treturn rate\n}\n` })
    const r = await check("zone-panic")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("go.no-panic")
    expect(r.report.decision.tier).toBe("owner")
  }, TIMEOUT)

  test("8. a test exiting the process and main code sniffing for go test are forbidden", async () => {
    scenario("cheats", {
      "domain/exit_test.go": "package domain\n\nimport (\n\t\"os\"\n\t\"testing\"\n)\n\nfunc TestLeaves(t *testing.T) {\n\tif !IsPositive(Money{1, \"EUR\"}) {\n\t\tt.Error(\"1\")\n\t}\n\tos.Exit(0)\n}\n",
      "infra/mode.go": "package infra\n\nimport \"testing\"\n\n// Strict is off under go test.\nvar Strict = !testing.Testing()\n",
    })
    const found = (await check("cheats")).report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("exit-in-tests")
    expect(found).toContain("test-refs-in-main")
  }, TIMEOUT)

  test("9. untested changed code fails coverage on changed lines", async () => {
    scenario("uncovered", { "infra/audit_log.go": "package infra\n\nimport \"fmt\"\n\n// Describe formats an amount.\nfunc Describe(minor int64, currency string) string {\n\tif minor > 0 {\n\t\treturn fmt.Sprintf(\"+%d %s\", minor, currency)\n\t}\n\treturn fmt.Sprintf(\"%d %s\", minor, currency)\n}\n" })
    expect((await check("uncovered")).status("coverage")).toBe("failed")
  }, TIMEOUT)

  test("10. a new test that only passes in file order is caught by shuffled reruns", async () => {
    scenario("order", {
      "domain/steps_test.go": `package domain

import "testing"

var seen []int

${[1, 2, 3, 4, 5, 6].map((n) => `func TestStep${n}(t *testing.T) {\n\tseen = append(seen, ${n})\n\tif len(seen) != ${n} || seen[${n - 1}] != ${n} {\n\t\tt.Errorf("ran out of order: %v", seen)\n\t}\n}\n`).join("\n")}`,
    })
    const r = await check("order")
    const unit = r.report.checks.find((c: { check: string }) => c.check === "unit")
    expect(unit.status).toBe("failed")
    expect(unit.reason).toMatch(/new or changed tests? (is|are) flaky/)
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await go(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, TIMEOUT)
})
