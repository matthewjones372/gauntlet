import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Just after setup, before it's pushed, the remote trunk has no baseline. A
// working-tree check judges from the local commit that recorded it, so the
// findings the baseline grandfathers aren't reported as new.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("a working-tree check before setup is pushed", () => {
  test("is judged from the commit that recorded the baseline", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.git("checkout", "-q", "main")
    const before = s.r.git("rev-parse", "HEAD").trim()
    s.r.git("update-ref", "refs/remotes/origin/main", before)
    s.r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    const b = await cli(["baseline", "--repo", s.r.dir, "--trunk", "main"])
    if (b.code !== 0) throw new Error(b.err)
    const recorded = s.r.commit("Record Gauntlet baseline")
    writeFileSync(join(s.r.dir, "src/main/App.kt"), "class App2\n")
    const res = await cli(["check", "--repo", s.r.dir, "--working-tree", "--json", "--out", join(s.r.dir, ".git", "out-wt")])
    expect(JSON.parse(res.out).policy.baseSha).toBe(recorded)
  }, 60_000)
})
