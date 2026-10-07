import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { typescriptPack } from "../src/index.ts"

// End to end on examples/fixtures/ts-service with the real tools: bun
// install, tsc, vitest with v8 coverage, Biome and StrykerJS. Opt in with
// GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "ts-service")
const TIMEOUT = 10 * 60 * 1000

let repo: TempRepo
let base = ""
const ts = (args: string[]) => cli(args, [typescriptPack])
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const scenario = (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
}

const check = async (name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await ts(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const status = (c: string) => report.checks.find((x: { check: string }) => x.check === c)?.status
  return { code: res.code, report, status }
}

describe.skipIf(!E2E)("TypeScript pack end to end (real tools)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(node_modules|coverage|reports|\.stryker-tmp)(\/|$)/.test(src) })
    repo.commit("trunk")
    const recorded = await ts(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers Biome's finding and records mutation and tests", () => {
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "biome").results).toHaveLength(1)
    expect(Object.keys(b.runs[0].properties.gauntlet.metrics.mutation.perFile)).toContain("src/domain/money.ts")
    expect(b.runs[0].properties.gauntlet.testIds).toHaveLength(4)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "src/domain/money.ts": `${read("src/domain/money.ts")}\nexport const negate = (m: Money): Money => money(-m.minor, m.currency)\n`,
      "test/domain/negate.test.ts": `import { expect, it } from "vitest"\nimport { money, negate } from "../../src/domain/money.ts"\n\nit("negates", () => {\n  expect(negate(money(5n, "EUR"))).toEqual(money(-5n, "EUR"))\n})\n`,
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a type error fails the build", async () => {
    scenario("type-error", { "src/infra/ledger.ts": `${read("src/infra/ledger.ts")}\nexport const broken: number = "nope"\n` })
    expect((await check("type-error")).status("build")).toBe("failed")
  }, TIMEOUT)

  test("3. a change that breaks a test fails the unit gate", async () => {
    scenario("broken", { "src/settlement/fx.ts": read("src/settlement/fx.ts").replace("10_000n", "1_000n") })
    const r = await check("broken")
    expect(r.status("unit")).toBe("failed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. weakening a protected test: base copy runs, change is forbidden", async () => {
    scenario("weakened", {
      "test/domain/money.test.ts": read("test/domain/money.test.ts")
        .replace('  it("refuses mixed currencies"', '  it.skip("refuses mixed currencies"')
        .replace('    expect(isPositive(money(0n, "EUR"))).toBe(false)\n', ""),
    })
    const r = await check("weakened")
    const found = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("new-skips")
    expect(found).toContain("weakened-assertions")
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("5. a grandfathered finding survives a line shift; a new one fails", async () => {
    scenario("shift", { "src/infra/ledger.ts": `// Ledger helpers.\n\n${read("src/infra/ledger.ts")}` })
    expect((await check("shift")).status("lint")).toBe("passed")
    scenario("new-finding", { "src/infra/ledger.ts": `${read("src/infra/ledger.ts")}\nexport const sameAmount = (a: Money, b: Money): boolean => a.minor == b.minor\n` })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("lint/suspicious/noDoubleEquals")
  }, TIMEOUT)

  test("6. domain importing infra breaks the arch rule", async () => {
    scenario("arch", { "src/domain/audit.ts": `import { total } from "../infra/ledger.ts"\n\nexport const audit = total\n` })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations[0].message).toBe("domain imports ../infra/ledger.ts, which belongs to infra.")
  }, TIMEOUT)

  test("7. a throw in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("zone-throw", {
      "src/settlement/fx.ts": `${read("src/settlement/fx.ts")}\nexport const requireRate = (rate: bigint): bigint => {\n  if (rate <= 0n) throw new Error("rate must be positive")\n  return rate\n}\n`,
    })
    const r = await check("zone-throw")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("ts.no-throw")
    expect(r.report.decision.tier).toBe("owner")
  }, TIMEOUT)

  test("8. a test exiting the process and main code sniffing for a test runner are forbidden", async () => {
    scenario("cheats", {
      "test/domain/exit.test.ts": `import { it } from "vitest"\n\nit("leaves", () => {\n  process.exit(0)\n})\n`,
      "src/infra/ledger.ts": `${read("src/infra/ledger.ts")}\nexport const strict = (): boolean => !process.env.VITEST\n`,
    })
    const found = (await check("cheats")).report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("exit-in-tests")
    expect(found).toContain("test-refs-in-main")
  }, TIMEOUT)

  test("9. an untested new file fails coverage on changed lines", async () => {
    scenario("uncovered", { "src/infra/audit-log.ts": `export const describeEntry = (minor: bigint, currency: string): string =>\n  minor > 0n ? \`+\${minor} \${currency}\` : \`\${minor} \${currency}\`\n` })
    const r = await check("uncovered")
    expect(r.status("coverage")).toBe("failed")
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await ts(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, TIMEOUT)
})
