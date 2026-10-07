import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FLAKY_TEST_SH, flakyPack } from "../../core/test/flaky-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// M15: flaky tests are caught where they enter, and an owner can excuse a
// known one until a date. TempRepo commits are dated 2026-01-01.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const setup = (extraPolicy = "", tests: Record<string, string> = {}) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ "scripts/test.sh": FLAKY_TEST_SH, ".gauntlet/policy.gx": `${POLICY}${extraPolicy}`, ...tests })
  const base = s.r.commit("flaky-aware tests")
  s.r.git("checkout", "-q", "-B", "feature")
  return { r: s.r, base }
}

let runs = 0
const check = async (r: TempRepo, base: string, record = false) => {
  const out = join(r.dir, ".git", `out-${++runs}`)
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, ...(record ? [] : ["--no-record"])], [flakyPack])
  const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
  return { code: res.code, report, unit: report.checks.find((c: { check: string }) => c.check === "unit"), reasons: report.decision.nominations.map((n: { reason: string }) => n.reason) as string[] }
}

describe("flaky tests", () => {
  test("a new test that depends on order is caught on its first appearance", async () => {
    const { r, base } = setup()
    r.write({ "src/test/CoinTest.txt": "coin\ncoin\n" })
    r.commit("adds an order-dependent test")
    const c = await check(r, base)
    expect(c.unit.status).toBe("failed")
    expect(c.unit.reason).toBe("1 new or changed test is flaky: passed and failed across 4 runs")
    expect(c.unit.flaky).toEqual(["svc.CoinTest.coin"])
    expect(c.code).toBe(1)
  })

  test("a new deterministic test is never called flaky", async () => {
    const { r, base } = setup()
    r.write({ "src/test/SteadyTest.txt": "steady\n" })
    r.commit("adds a steady test")
    const c = await check(r, base)
    expect(c.unit.status).toBe("passed")
    expect(c.unit.flaky).toBeUndefined()
    expect(c.report.decision.tier).toBe("auto")
  })

  test("an old test that fails and then passes alone is flaky: it doesn't block, but it needs review", async () => {
    const { r, base } = setup("", { "src/test/NervousTest.txt": "nervous\nnervous\n" })
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("unrelated change")
    const c = await check(r, base)
    expect(c.unit.status).toBe("passed")
    expect(c.unit.reason).toBe("1 failure passed when run again alone (flaky)")
    expect(c.report.decision.blocking).toBe(false)
    expect(c.report.decision.tier).toBe("review")
    expect(c.reasons).toContain("unit passed only because a failing test passed when run again: svc.NervousTest.nervous. Flaky tests hide real failures.")
  })

  test("a real failure fails again on its own and still blocks", async () => {
    const { r, base } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks add")
    const c = await check(r, base)
    expect(c.unit.status).toBe("failed")
    expect(c.unit.flaky).toBeUndefined()
    expect(c.unit.failures).toEqual(["svc.AddTest.add: add is broken"])
  })
})

describe("quarantine", () => {
  const breakRound = (r: TempRepo) => {
    r.write({ "src/main/behaviour.txt": "broken round\n" })
    r.commit("round fails")
  }

  test("an owner's quarantine excuses a failure until its date", async () => {
    const { r, base } = setup(`quarantine {\n  "svc.RoundTest.round" until 2026-06-01 owner @platform\n}\n`)
    breakRound(r)
    const c = await check(r, base)
    expect(c.unit.status).toBe("passed")
    expect(c.unit.quarantined).toEqual(["svc.RoundTest.round"])
    expect(c.unit.reason).toBe("1 quarantined failure excused by the policy")
  })

  test("after the date the failure blocks again, and says the quarantine expired", async () => {
    const { r, base } = setup(`quarantine {\n  "svc.RoundTest.round" until 2025-12-31 owner @platform\n}\n`)
    breakRound(r)
    const c = await check(r, base)
    expect(c.unit.status).toBe("failed")
    expect(c.unit.reason).toBe("1 of 2 tests failed; the quarantine of svc.RoundTest.round expired after 2025-12-31")
  })

  test("a quarantine added in the change itself counts for nothing: the base policy judges", async () => {
    const { r, base } = setup()
    r.write({ "src/main/behaviour.txt": "broken round\n", ".gauntlet/policy.gx": `${POLICY}quarantine {\n  "svc.RoundTest.round" until 2026-06-01 owner @platform\n}\n` })
    r.commit("breaks round and quarantines it")
    const out = join(r.dir, ".git", "out-pr")
    await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", out, "--no-record"], [flakyPack])
    const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
    expect(report.checks.find((c: { check: string }) => c.check === "unit").status).toBe("failed")
    expect(report.decision.tier).toBe("owner")
  })
})

describe("retries and risky test code", () => {
  test("adding retries is forbidden; sleeps and the wall clock in a test are flagged", async () => {
    const { r, base } = setup()
    r.write({
      "src/test/RetryTest.txt": "retry\n// @RetryingTest(3)\n",
      "src/test/ClockTest.txt": "clock\nThread.sleep(100); val now = Instant.now()\n",
      "deps.txt": "pytest-rerunfailures\n",
    })
    r.commit("retries and sleeps")
    const c = await check(r, base)
    const findings = c.report.integrity.findings.map((f: { check: string; kind: string; path: string }) => `${f.kind} ${f.check} ${f.path}`)
    expect(findings).toContain("forbid added-retries src/test/RetryTest.txt")
    expect(findings).toContain("flag flaky-patterns src/test/ClockTest.txt")
    expect(c.report.decision.blocking).toBe(true)
  })
})

describe("gauntlet report flaky", () => {
  test("lists tests that passed and failed on identical code", async () => {
    const { r, base } = setup("", { "src/test/NervousTest.txt": "nervous\nnervous\n" })
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("unrelated change")
    await check(r, base, true)
    const text = (await cli(["report", "flaky", "--repo", r.dir])).out
    expect(text).toContain("| `svc.NervousTest.nervous` | unit | 1 |")
    expect(JSON.parse((await cli(["report", "flaky", "--repo", r.dir, "--json"])).out).tests).toHaveLength(1)
  })

  test("says when there are none", async () => {
    const { r } = setup()
    expect((await cli(["report", "flaky", "--repo", r.dir])).out).toBe("No flaky tests in 0 recorded checks.\n")
  })
})
