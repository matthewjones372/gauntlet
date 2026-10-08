import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Edited tests run as edited (ADR 0021), so a change can stop the suite
// running anything at all. When the base ran tests and the change runs none,
// every base test counts as no longer running.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("a change after which no tests run", () => {
  test("every test the baseline recorded is reported as no longer running", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.git("checkout", "-q", "main")
    expect((await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])).code).toBe(0)
    const base = s.r.commit("baseline")
    s.r.git("checkout", "-q", "-b", "nothing-runs")
    rmSync(join(s.r.dir, "src/test/AddTest.txt"))
    rmSync(join(s.r.dir, "src/test/RoundTest.txt"))
    s.r.commit("no tests left")
    const out = join(s.r.dir, "out")
    const res = await cli(["check", "--repo", s.r.dir, "--base", base, "--out", out])
    const findings = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).integrity.findings
    expect(findings.filter((f: { check: string; kind: string }) => f.check === "deleted-tests" && f.kind === "forbid").map((f: { message: string }) => f.message)).toEqual(expect.arrayContaining([
      "Test svc.AddTest.add ran at base and no longer runs.",
      "Test svc.RoundTest.round ran at base and no longer runs.",
    ]))
    expect(res.code).toBe(1)
  })
})
