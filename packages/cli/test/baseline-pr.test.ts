import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// A pull request whose only change is `.gauntlet/baseline.sarif` (spec 0015)
// is judged against the baseline it brings for the metrics it lowers, and is
// owner tier: the owner's approval accepts the lower bar, with no override.
// Anything else in the same pull request and it's judged as before, so a lower
// bar can't ride in with code.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const RATCHET_POLICY = POLICY.replace("coverage >= 80%", "coverage ratchet >= 80%")

/**
 * Main with a baseline recorded at 95% coverage, then a merge that left
 * coverage at 85%, and a branch off it that lowers the baseline to match.
 */
const loweringBaseline = async () => {
  const s = baseRepo()
  repos.push(s.r)
  const r = s.r
  r.git("checkout", "-q", "main")
  r.write({ ".gauntlet/policy.gx": RATCHET_POLICY, "coverage.txt": "95\n" })
  r.commit("ratchet coverage")
  expect((await cli(["baseline", "--repo", r.dir, "--trunk", "main"])).code).toBe(0)
  r.commit("record the baseline")
  r.write({ "coverage.txt": "85\n" })
  const main = r.commit("merged with an override: coverage is 85% now")
  expect((await cli(["baseline", "--repo", r.dir, "--trunk", "main", "--update", "--allow-lower"])).code).toBe(0)
  r.git("checkout", "-q", "-b", "lower-baseline")
  const head = r.commit("lower the baseline to 85%")
  return { r, main, head }
}

const check = async (r: TempRepo, main: string) => {
  const res = await cli(["check", "--repo", r.dir, "--policy-ref", main, "--out", join(r.dir, "evidence"), "--no-record"])
  return { ...res, report: JSON.parse(readFileSync(join(r.dir, "evidence", "gauntlet-report.json"), "utf8")) }
}

const statusWith = async (r: TempRepo, main: string, comments: object[]) => {
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  writeFileSync(join(r.dir, "comments.json"), JSON.stringify(comments))
  await cli(["github-status", "--repo", r.dir, "--policy-ref", main, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--out", "trusted"])
  return JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8"))
}

describe("a pull request that only lowers the baseline", () => {
  test("is judged against the baseline it brings, and needs an owner, not an override", async () => {
    const { r, main, head } = await loweringBaseline()
    const { code, report } = await check(r, main)
    expect(code).toBe(0)
    expect(report.decision.blocking).toBe(false)
    expect(report.decision.tier).toBe("owner")
    const lowered = report.decision.nominations.find((n: { rule: string }) => n.rule === "baseline-lowered")
    expect(lowered).toMatchObject({ tier: "owner", blocking: false })
    expect(lowered.reason).toBe("This pull request only changes the baseline, and lowers coverage (95 to 85). It's judged against the baseline it brings; an owner's approval accepts the lower bar.")

    expect((await statusWith(r, main, [])).conclusion).toBe("action_required")
    const approved = await statusWith(r, main, [{ user: "platform", body: `/gauntlet approve ${head.slice(0, 12)}` }])
    expect(approved.conclusion).toBe("success")
    expect(approved.honouredOverrides).toEqual([])
  }, 60_000)

  test("someone who isn't an owner can't accept it", async () => {
    const { r, main, head } = await loweringBaseline()
    await check(r, main)
    expect((await statusWith(r, main, [{ user: "mallory", body: `/gauntlet approve ${head.slice(0, 12)}` }])).conclusion).toBe("action_required")
  }, 60_000)
})

describe("a lower baseline with anything else", () => {
  test("code in the same pull request: judged against the base's baseline, and blocked", async () => {
    const { r, main } = await loweringBaseline()
    r.write({ "src/main/App.kt": "class App { val extra = 1 }\n" })
    r.commit("and some code")
    const { code, report } = await check(r, main)
    expect(code).toBe(1)
    expect(report.decision.nominations.some((n: { rule: string }) => n.rule === "baseline-lowered")).toBe(false)
    expect(report.decision.nominations.find((n: { rule: string }) => n.rule === "ratchet-regression")?.reason).toBe("coverage dropped below the baseline (95 to 85).")
  }, 60_000)

  test("a further drop riding along: blocked against the base's baseline", async () => {
    const { r, main } = await loweringBaseline()
    r.write({ "coverage.txt": "70\n" })
    r.commit("and lower coverage again")
    const { code } = await check(r, main)
    expect(code).toBe(1)
  }, 60_000)

  test("a baseline that doesn't parse lowers nothing", async () => {
    const { r, main } = await loweringBaseline()
    r.write({ ".gauntlet/baseline.sarif": "{ not sarif" })
    r.commit("broken baseline")
    const { code, report } = await check(r, main)
    expect(code).toBe(1)
    expect(report.decision.nominations.some((n: { rule: string }) => n.rule === "baseline-lowered")).toBe(false)
  }, 60_000)
})
