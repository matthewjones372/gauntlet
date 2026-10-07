import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const setup = () => {
  const s = baseRepo()
  repos.push(s.r)
  return s
}
const reportOf = (dir: string) => JSON.parse(readFileSync(join(dir, "gauntlet-report.json"), "utf8"))

describe("gauntlet validate", () => {
  test("a valid policy exits 0 and prints its IR hash", async () => {
    const { r } = setup()
    const res = await cli(["validate", "--repo", r.dir])
    expect(res.code).toBe(0)
    expect(res.out).toMatch(/is valid \(IR [0-9a-f]{12}\)/)
  })

  test("an invalid policy exits 1 with located diagnostics", async () => {
    const { r } = setup()
    r.write({ ".gauntlet/policy.gx": POLICY.replace("mode enforce", "mode enforse") })
    const res = await cli(["validate", "--repo", r.dir])
    expect(res.code).toBe(1)
    expect(res.out).toContain(".gauntlet/policy.gx:3:6  error[unknown-mode]")
    expect(res.out).toContain("fix: Did you mean 'enforce'?")
  })

  test("--json reports validity and diagnostics", async () => {
    const { r } = setup()
    const res = await cli(["validate", "--repo", r.dir, "--json"])
    expect(JSON.parse(res.out).valid).toBe(true)
  })
})

describe("gauntlet check", () => {
  test("a small clean change gets auto and exits 0, writing all four files", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "class App { fun hello() = 1 }\n" })
    r.commit("small change")
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    expect(res.code).toBe(0)
    expect(res.out).toContain("## Gauntlet: auto")
    const report = reportOf(out)
    expect(report.decision.tier).toBe("auto")
    expect(report.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual(["build:passed", "lint:passed", "coverage:passed", "unit:passed"])
    expect(["gauntlet-evidence.sarif", "gauntlet-report.md", "gauntlet-run.json"].every((f) => existsSync(join(out, f)))).toBe(true)
  })

  test("without language detectors, missing integrity evidence holds a clean change at review", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "class App { fun hello() = 1 }\n" })
    r.commit("small change")
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out], [{ ...scriptPack, detectors: [] }])
    expect(res.code).toBe(0)
    expect(reportOf(out).decision.tier).toBe("review")
    expect(reportOf(out).integrity.notExecuted).toContain("weakened-assertions")
  })

  test("a change that breaks a test is blocked in enforce mode (exit 1) and only reported in shadow", async () => {
    const { r, base } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("break it")
    const out = join(r.dir, "out")
    const enforce = await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    expect(enforce.code).toBe(1)
    expect(reportOf(out).checks.find((c: { check: string }) => c.check === "unit").reason).toBe("1 of 2 tests failed")

    r.git("checkout", "-q", base)
    r.write({ ".gauntlet/policy.gx": POLICY.replace("mode enforce", "mode shadow") })
    const shadowBase = r.commit("shadow")
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("break it again")
    const shadow = await cli(["check", "--repo", r.dir, "--base", shadowBase, "--out", out])
    expect(shadow.code).toBe(0)
    expect(reportOf(out).decision.wouldBlock).toBe(true)
  })

  test("a planted report and a gutted test script don't fake a pass", async () => {
    const { r, base } = setup()
    r.write({
      "scripts/test.sh": "exit 0\n",
      "build/test-results/TEST-planted.xml": `<testsuite name="x"><testcase classname="a" name="b"/></testsuite>`,
      "src/main/behaviour.txt": "broken round\n",
    })
    r.commit("cheat")
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    const unit = reportOf(out).checks.find((c: { check: string }) => c.check === "unit")
    expect(unit.tests.executed).toBe(2)
    expect(unit.status).toBe("failed")
    expect(res.code).toBe(1)
    expect(reportOf(out).facts.protectedTouched.map((p: { path: string; action: string }) => `${p.action} ${p.path}`)).toEqual(["restored scripts/test.sh"])
  })

  test("a PR that loosens the policy is judged by the base policy and needs an owner", async () => {
    const { r, base } = setup()
    r.write({ ".gauntlet/policy.gx": POLICY.replace("coverage >= 80%", "coverage >= 10%"), "coverage.txt": "50\n" })
    r.commit("loosen and drop coverage")
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", out])
    const report = reportOf(out)
    expect(res.code).toBe(1)
    expect(report.policy.origin).toBe("base")
    expect(report.decision.tier).toBe("owner")
    expect(report.checks.find((c: { check: string }) => c.check === "coverage").reason).toContain(">= 80%")
    expect(report.remediation).toEqual([{ check: "coverage", fix: "Add tests for the changed lines." }])
  })

  test("two runs on the same commit write byte-identical report, markdown and evidence", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "class App { fun hello() = 2 }\n" })
    r.commit("change")
    const a = join(r.dir, "a")
    const b = join(r.dir, "b")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", a])
    await cli(["check", "--repo", r.dir, "--base", base, "--out", b])
    for (const f of ["gauntlet-report.json", "gauntlet-report.md", "gauntlet-evidence.sarif"]) {
      expect(readFileSync(join(b, f), "utf8")).toBe(readFileSync(join(a, f), "utf8"))
    }
  })

  test("an unknown base ref exits 2 with a hint", async () => {
    const { r } = setup()
    const res = await cli(["check", "--repo", r.dir, "--policy-ref", "nope", "--out", join(r.dir, "out")])
    expect(res.code).toBe(2)
    expect(res.err).toContain("git fetch origin nope")
  })

  test("bad arguments exit 2", async () => {
    const { r } = setup()
    expect((await cli(["check", "--repo", r.dir, "--bogus"])).code).toBe(2)
  })
})

describe("gauntlet explain", () => {
  test("--ir prints the canonical IR with the same hash validate reports", async () => {
    const { r } = setup()
    const ir = JSON.parse((await cli(["explain", "--repo", r.dir, "--ir"])).out)
    const validated = JSON.parse((await cli(["validate", "--repo", r.dir, "--json"])).out)
    expect(ir.irHash).toBe(validated.irHash)
    expect(ir.ir.name).toBe("svc")
  })

  test("--coverage lists what nothing covers", async () => {
    const { r } = setup()
    const res = await cli(["explain", "--repo", r.dir, "--coverage"])
    expect(res.out).toContain("src/money/Fx.kt  zone money")
    expect(res.out).toContain("Not covered:\n  coverage.txt")
    expect(res.out).not.toContain("  src/test/AddTest.txt\n")
  })

  test("a block explains itself; an unknown block exits 2", async () => {
    const { r } = setup()
    expect((await cli(["explain", "review", "--repo", r.dir])).out).toContain("- owner when a zone is touched")
    expect((await cli(["explain", "nonsense", "--repo", r.dir])).code).toBe(2)
  })
})

describe("gauntlet override", () => {
  test("records an override that the next check reports but doesn't honour locally", async () => {
    const { r, base } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("break it")
    const recorded = await cli(["override", "--repo", r.dir, "--base", base, "--reason", "hotfix for the incident, tests fixed tomorrow", "--approver", "@payments"])
    expect(recorded.code).toBe(0)
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    expect(res.code).toBe(1)
    expect(reportOf(out).decision.overrides).toEqual([expect.objectContaining({ approver: "@payments", honoured: false })])
  })

  test("a vague reason or a malformed approver is refused", async () => {
    const { r, base } = setup()
    expect((await cli(["override", "--repo", r.dir, "--base", base, "--reason", "pls", "--approver", "@x"])).code).toBe(2)
    expect((await cli(["override", "--repo", r.dir, "--base", base, "--reason", "a perfectly long reason", "--approver", "payments"])).code).toBe(2)
  })
})
