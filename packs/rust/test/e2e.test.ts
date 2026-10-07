import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cli } from "../../../packages/cli/test/harness.ts"
import { TempRepo } from "../../../packages/core/test/temp-repo.ts"
import { rustPack } from "../src/index.ts"

// End to end on examples/fixtures/rust-service with the real tools: cargo
// build, cargo-nextest, clippy, cargo-mutants and cargo-llvm-cov. Opt in with
// GAUNTLET_E2E=1; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "rust-service")
const TIMEOUT = 15 * 60 * 1000

let repo: TempRepo
let base = ""
const rs = (args: string[]) => cli(args, [rustPack])
const read = (p: string) => readFileSync(join(FIXTURE, p), "utf8")

const scenario = (name: string, files: Record<string, string>) => {
  repo.git("checkout", "-q", "-B", name, base)
  repo.write(files)
  repo.commit(name)
}

const check = async (name: string) => {
  const out = join(repo.dir, ".git", `out-${name}`)
  const res = await rs(["check", "--repo", repo.dir, "--policy-ref", base, "--out", out, "--no-record"])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  const status = (c: string) => report.checks.find((x: { check: string }) => x.check === c)?.status
  return { code: res.code, report, status }
}

describe.skipIf(!E2E)("Rust pack end to end (real tools)", () => {
  beforeAll(async () => {
    repo = new TempRepo()
    cpSync(FIXTURE, repo.dir, { recursive: true, filter: (src) => !/\/(target|mutants\.out[^/]*)(\/|$)/.test(src) })
    repo.commit("trunk")
    const recorded = await rs(["baseline", "--repo", repo.dir, "--trunk", "main"])
    if (recorded.code !== 0) throw new Error(`baseline failed: ${recorded.err}\n${recorded.out}`)
    base = repo.commit("baseline")
  }, TIMEOUT)

  afterAll(() => repo?.cleanup())

  test("the baseline grandfathers clippy's finding and records mutation and tests", () => {
    const b = JSON.parse(readFileSync(join(repo.dir, ".gauntlet", "baseline.sarif"), "utf8"))
    expect(b.runs.find((r: { tool: { driver: { name: string } } }) => r.tool.driver.name === "clippy").results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["clippy::needless_return"])
    expect(Object.keys(b.runs[0].properties.gauntlet.metrics.mutation.perFile)).toContain("src/domain/money.rs")
    expect(b.runs[0].properties.gauntlet.testIds).toHaveLength(4)
  })

  test("1. a small, tested change gets auto", async () => {
    scenario("clean", {
      "src/domain/money.rs": `${read("src/domain/money.rs")}\n/// Flips the sign.\npub fn negate(m: &Money) -> Money {\n    Money::new(-m.minor, &m.currency)\n}\n`,
      "tests/negate.rs": "use svc::domain::money::{negate, Money};\n\n#[test]\nfn negates() {\n    assert_eq!(negate(&Money::new(5, \"EUR\")), Money::new(-5, \"EUR\"));\n}\n",
    })
    const r = await check("clean")
    expect(r.report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual([
      "arch:passed", "build:passed", "lint:passed", "coverage:passed", "mutation:passed", "unit:passed",
    ])
    expect(r.report.decision.tier).toBe("auto")
    expect(r.code).toBe(0)
  }, TIMEOUT)

  test("2. a compile error fails the build", async () => {
    scenario("compile-error", { "src/infra/ledger.rs": `${read("src/infra/ledger.rs")}\npub const BROKEN: i32 = "nope";\n` })
    expect((await check("compile-error")).status("build")).toBe("failed")
  }, TIMEOUT)

  test("3. a change that breaks a test fails the unit gate, and names the test", async () => {
    scenario("broken", { "src/settlement/fx.rs": read("src/settlement/fx.rs").replace("/ 10_000", "/ 1_000") })
    const r = await check("broken")
    const unit = r.report.checks.find((c: { check: string }) => c.check === "unit")
    expect(unit.status).toBe("failed")
    expect(unit.failures[0]).toStartWith("svc::fx.converts")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("4. weakening a protected test: base copy runs, change is forbidden", async () => {
    scenario("weakened", {
      "tests/money.rs": read("tests/money.rs")
        .replace("#[test]\nfn refuses_mixed_currencies", "#[test]\n#[ignore]\nfn refuses_mixed_currencies")
        .replace("    assert!(!is_positive(&Money::new(0, \"EUR\")));\n", ""),
    })
    const r = await check("weakened")
    const found = r.report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("new-skips")
    expect(found).toContain("weakened-assertions")
    expect(r.status("unit")).toBe("passed")
    expect(r.code).toBe(1)
  }, TIMEOUT)

  test("5. a grandfathered finding survives a line shift; a new one fails", async () => {
    scenario("shift", { "src/infra/ledger.rs": `//! The ledger keeps balances.\n\n${read("src/infra/ledger.rs")}` })
    expect((await check("shift")).status("lint")).toBe("passed")
    scenario("new-finding", { "src/infra/ledger.rs": `${read("src/infra/ledger.rs")}\n/// Counts entries.\npub fn count(entries: &[Money]) -> usize {\n    return entries.len();\n}\n` })
    const r = await check("new-finding")
    expect(r.status("lint")).toBe("failed")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("clippy::needless_return")
  }, TIMEOUT)

  test("6. domain using infra breaks the arch rule", async () => {
    scenario("arch", {
      "src/domain/mod.rs": "pub mod audit;\npub mod money;\n",
      "src/domain/audit.rs": "use crate::infra::ledger::total;\n\n/// Totals for audits.\npub const AUDIT: fn(&[crate::domain::money::Money], &str) -> crate::domain::money::Money = total;\n",
    })
    const r = await check("arch")
    expect(r.status("arch")).toBe("failed")
    expect(r.report.violations.find((v: { ruleId: string }) => v.ruleId.startsWith("arch/")).message).toBe("domain uses crate::infra::ledger::total, which belongs to infra.")
  }, TIMEOUT)

  test("7. a panic in the money zone breaks the zone rule and needs an owner", async () => {
    scenario("zone-panic", { "src/settlement/fx.rs": `${read("src/settlement/fx.rs")}\n/// Checks a rate.\npub fn require_rate(rate: i64) -> i64 {\n    if rate <= 0 {\n        panic!("rate must be positive");\n    }\n    rate\n}\n` })
    const r = await check("zone-panic")
    expect(r.report.violations.map((v: { ruleId: string }) => v.ruleId)).toContain("rust.no-panic")
    expect(r.report.decision.tier).toBe("owner")
  }, TIMEOUT)

  test("8. a test exiting the process and main code checking cfg!(test) are forbidden", async () => {
    scenario("cheats", {
      "tests/exit.rs": "use svc::domain::money::{is_positive, Money};\n\n#[test]\nfn leaves() {\n    assert!(is_positive(&Money::new(1, \"EUR\")));\n    std::process::exit(0);\n}\n",
      "src/infra/ledger.rs": `${read("src/infra/ledger.rs")}\n/// Strict outside tests.\npub fn strict() -> bool {\n    !cfg!(test)\n}\n`,
    })
    const found = (await check("cheats")).report.integrity.findings.map((f: { check: string }) => f.check)
    expect(found).toContain("exit-in-tests")
    expect(found).toContain("test-refs-in-main")
  }, TIMEOUT)

  test("9. untested changed code fails coverage on changed lines", async () => {
    scenario("uncovered", {
      "src/infra/mod.rs": "pub mod audit_log;\npub mod ledger;\n",
      "src/infra/audit_log.rs": "/// Describes an amount.\npub fn describe(minor: i64, currency: &str) -> String {\n    if minor > 0 {\n        format!(\"+{minor} {currency}\")\n    } else {\n        format!(\"{minor} {currency}\")\n    }\n}\n",
    })
    expect((await check("uncovered")).status("coverage")).toBe("failed")
  }, TIMEOUT)

  test("selftest: every built-in tamper fixture that applies is caught", async () => {
    repo.git("checkout", "-q", "-B", "selftest", base)
    const res = await rs(["selftest", "--repo", repo.dir, "--json"])
    const result = JSON.parse(res.out)
    const missed = result.fixtures.filter((f: { caught: boolean }) => !f.caught)
    if (missed.length > 0 || result.control.wouldBlock) console.log(JSON.stringify(result, null, 1))
    expect(result.control.wouldBlock).toBe(false)
    expect(missed).toEqual([])
    expect(result.fixtures.length).toBeGreaterThanOrEqual(9)
  }, TIMEOUT)
})
