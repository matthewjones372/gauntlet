import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const shadowRepo = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  s.r.write({ ".gauntlet/policy.gx": POLICY.replace("mode enforce", "mode shadow") })
  const base = s.r.commit("shadow policy")
  s.r.git("checkout", "-q", "-b", "work")
  return { r: s.r, base }
}

describe("shadow mode and gauntlet report shadow", () => {
  test("checks exit 0 even when they would block, and each is recorded", async () => {
    const { r, base } = shadowRepo()
    const outcomes: number[] = []
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("clean")
    outcomes.push((await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "o")])).code)
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    outcomes.push((await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "o")])).code)
    r.write({ "src/money/Fx.kt": "class Fx { val rate = 1 }\n" })
    r.commit("touches money")
    outcomes.push((await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "o")])).code)
    expect(outcomes).toEqual([0, 0, 0])

    const summary = JSON.parse((await cli(["report", "shadow", "--repo", r.dir, "--json"])).out)
    expect(summary.runs).toBe(3)
    expect(summary.shadowRuns).toBe(3)
    expect(summary.wouldBlock).toBe(2)
    expect(summary.tiers).toEqual({ auto: 1, skim: 0, review: 1, owner: 1 })
    expect(summary.topReasons[0]).toEqual({ reason: "gate-failed (.gauntlet/policy.gx:13 verify { unit, coverage >= 80% })", count: 2 })

    const text = (await cli(["report", "shadow", "--repo", r.dir])).out
    expect(text).toContain("3 changes checked (3 in shadow mode). 2 (67%) would have been blocked")
  })

  test("--no-record leaves no history, and an empty history says how to fetch it", async () => {
    const { r, base } = shadowRepo()
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("clean")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "o"), "--no-record"])
    expect((await cli(["report", "shadow", "--repo", r.dir])).out).toContain("git fetch origin refs/notes/gauntlet:refs/notes/gauntlet")
  })

  test("--since filters by date", async () => {
    const { r, base } = shadowRepo()
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("clean")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "o")])
    expect(JSON.parse((await cli(["report", "shadow", "--repo", r.dir, "--json", "--since", "2999-01-01"])).out).runs).toBe(0)
    expect(JSON.parse((await cli(["report", "shadow", "--repo", r.dir, "--json", "--since", "2000-01-01"])).out).runs).toBe(1)
  })
})
