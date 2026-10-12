import { afterEach, describe, expect, test } from "bun:test"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Selftest and check over a policy with an affected suite (spec 0013), without
// Gradle: selftest judges its fixtures with gates skipped, where selection and
// integrity's accounting for it have no suite run to read.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const AFFECTED = POLICY.replace(`suites { unit "src/test/**" }`, `suites { unit "src/test/**" affected }`)

const trunk = async (policy: string) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": policy })
  s.r.commit("policy")
  const b = await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])
  if (b.code !== 0) throw new Error(b.err)
  s.r.commit("baseline")
  return s.r
}

describe("an affected suite in selftest and check", () => {
  for (const [name, policy] of [["with affected", AFFECTED], ["without it", POLICY]] as const) {
    test(`selftest reports every fixture, ${name}`, async () => {
      const r = await trunk(policy)
      const res = await cli(["selftest", "--repo", r.dir, "--json"])
      // When selftest wrote nothing, say what it said instead: CI keeps nothing to read afterwards.
      if (res.out.trim() === "") console.log(`selftest wrote nothing (exit ${res.code}):\n${res.err}`)
      expect(res.err).not.toContain("Error")
      const result = JSON.parse(res.out)
      expect(result.control.wouldBlock).toBe(false)
      expect(result.fixtures.filter((f: { caught: boolean }) => !f.caught)).toEqual([])
    }, 120000)
  }

  test("a check of a pack that records no map runs every test, and integrity counts them all", async () => {
    const r = await trunk(AFFECTED)
    r.git("checkout", "-q", "-b", "change")
    r.write({ "src/main/App.kt": "class App {\n  val x = 1\n}\n" })
    const head = r.commit("change")
    const out = `${r.dir}/.git/out`
    const res = await cli(["check", "--repo", r.dir, "--base", "main", "--head", head, "--out", out, "--no-record"])
    expect(res.code).toBe(0)
    const report = JSON.parse(await Bun.file(`${out}/gauntlet-report.json`).text())
    expect(report.checks.find((c: { check: string }) => c.check === "unit").tests.executed).toBe(2)
    expect(report.integrity.findings).toEqual([])
  }, 120000)
})
