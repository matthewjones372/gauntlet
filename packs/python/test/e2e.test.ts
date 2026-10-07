import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { pythonPack } from "../src/index.ts"

// End to end on examples/fixtures/py-service with the real tools: uv,
// mypy, pytest, coverage.py, ruff and mutmut. Opt in with GAUNTLET_E2E=1.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "py-service")
const TIMEOUT = 10 * 60 * 1000

let repo: TempRepo
let base = ""
const py = (args: string[]) => cli(args, [pythonPack])
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const scenario = (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
}

const check = async (name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await py(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const status = (c: string) => report.checks.find((x: { check: string }) => x.check === c)?.status
  return { code: res.code, report, status }
}

describe.skipIf(!E2E)("Python pack end to end (real tools)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(\.venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|mutants)(\/|$)/.test(src) })
    repo.commit("trunk")
    const recorded = await py(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers ruff's finding and records mutation and tests", () => {
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "ruff").results).toHaveLength(1)
    expect(Object.keys(b.runs[0].properties.gauntlet.metrics.mutation.perFile)).toContain("src/svc/domain/money.py")
    expect(b.runs[0].properties.gauntlet.testIds).toHaveLength(4)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "src/svc/domain/money.py": `${read("src/svc/domain/money.py")}\n\ndef negate(m: Money) -> Money:\n    return Money(-m.minor, m.currency)\n`,
      "tests/domain/test_negate.py": "from svc.domain.money import Money, negate\n\n\ndef test_negates():\n    assert negate(Money(5, \"EUR\")) == Money(-5, \"EUR\")\n",
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a type error fails the build", async () => {
    scenario("type-error", { "src/svc/infra/ledger.py": `${read("src/svc/infra/ledger.py")}\n\nbroken: int = "nope"\n` })
    expect((await check("type-error")).status("build")).toBe("failed")
  }, TIMEOUT)

  test("3. a change that breaks a test fails the unit gate", async () => {
    scenario("broken", { "src/svc/settlement/fx.py": read("src/svc/settlement/fx.py").replace("// 10_000", "// 1_000") })
    const r = await check("broken")
    expect(r.status("unit")).toBe("failed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. weakening a protected test: base copy runs, change is forbidden", async () => {
    scenario("weakened", {
      "tests/domain/test_money.py": read("tests/domain/test_money.py")
        .replace("def test_refuses_mixed_currencies", "@pytest.mark.skip\ndef test_refuses_mixed_currencies")
        .replace('    assert not is_positive(Money(0, "EUR"))\n', ""),
    })
    const r = await check("weakened")
    const found = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("new-skips")
    expect(found).toContain("weakened-assertions")
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("5. a grandfathered finding survives a line shift; a new one fails", async () => {
    scenario("shift", { "src/svc/infra/ledger.py": `"""Ledger helpers."""\n\n${read("src/svc/infra/ledger.py")}` })
    expect((await check("shift")).status("lint")).toBe("passed")
    scenario("new-finding", { "src/svc/infra/ledger.py": `${read("src/svc/infra/ledger.py")}\n\ndef tags(entries: list[Money], seen={}) -> int:\n    return len(seen)\n` })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("B006")
  }, TIMEOUT)

  test("6. domain importing infra breaks the arch rule", async () => {
    scenario("arch", { "src/svc/domain/audit.py": "from svc.infra.ledger import total\n\nAUDIT = total\n" })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations[0].message).toBe("domain imports svc.infra.ledger, which belongs to infra.")
  }, TIMEOUT)

  test("7. a raise in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("zone-raise", {
      "src/svc/settlement/fx.py": `${read("src/svc/settlement/fx.py")}\n\ndef require_rate(rate: int) -> int:\n    if rate <= 0:\n        raise ValueError("rate must be positive")\n    return rate\n`,
    })
    const r = await check("zone-raise")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("py.no-raise")
    expect(r.report.decision.tier).toBe("owner")
  }, TIMEOUT)

  test("8. a test exiting the process and main code sniffing for pytest are forbidden", async () => {
    scenario("cheats", {
      "tests/domain/test_exit.py": "import sys\n\n\ndef test_leaves():\n    sys.exit(0)\n",
      "src/svc/infra/ledger.py": `${read("src/svc/infra/ledger.py")}\n\nimport os\nSTRICT = "PYTEST_CURRENT_TEST" not in os.environ\n`,
    })
    const found = (await check("cheats")).report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("exit-in-tests")
    expect(found).toContain("test-refs-in-main")
  }, TIMEOUT)

  test("9. untested changed code fails coverage on changed lines", async () => {
    scenario("uncovered", { "src/svc/infra/audit_log.py": "def describe(minor: int, currency: str) -> str:\n    if minor > 0:\n        return f\"+{minor} {currency}\"\n    return f\"{minor} {currency}\"\n" })
    expect((await check("uncovered")).status("coverage")).toBe("failed")
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await py(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, TIMEOUT)
})
