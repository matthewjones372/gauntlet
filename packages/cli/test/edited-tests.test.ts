import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A changed requirement changes its tests. The edited test runs as the change
// has it, so the change isn't blocked, and it always needs review, never auto.
// Protect-only, pass or fail with no review step, still runs the base's tests.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const reportOf = (dir: string) => JSON.parse(readFileSync(join(dir, "gauntlet-report.json"), "utf8"))

/** Rounding changes on purpose: the code and the test that states it change together. */
const requirementChange = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/main/behaviour.txt": "broken round\n", "src/test/RoundTest.txt": "bankers\n" })
  s.r.commit("rounding is banker's rounding now")
  return s
}

describe("an edited protected test", () => {
  test("runs as edited: the change isn't blocked, and it needs review", async () => {
    const { r, base } = requirementChange()
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    const report = reportOf(out)
    expect(res.code).toBe(0)
    expect(report.checks.find((c: { check: string }) => c.check === "unit").status).toBe("passed")
    expect(report.facts.protectedTouched).toContainEqual(expect.objectContaining({ path: "src/test/RoundTest.txt", action: "edited" }))
    expect(report.decision.tier).not.toBe("auto")
    expect(res.out).toContain("src/test/RoundTest.txt is a protected test (tests) the change edits; it runs as the change has it and needs review.")
  })

  test("protect-only still runs the base's version, so the old requirement fails", async () => {
    const { r, base } = requirementChange()
    const out = join(r.dir, "out")
    const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--protect-only"])
    expect(res.code).toBe(1)
    expect(reportOf(out).facts.protectedTouched).toContainEqual(expect.objectContaining({ path: "src/test/RoundTest.txt", action: "restored" }))
  })
})
