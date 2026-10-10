import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A stack merged without deleting each branch merges the next pull request
// into the branch below, not the default branch: the top's warning says to
// delete each branch as it merges.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("merging a stack", () => {
  test("the top's warning says to delete each branch as it merges", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 1 }\n" })
    s.r.commit("touch money")
    await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", join(s.r.dir, "evidence"), "--no-record"])
    for (const [f, t] of [["reviews.json", "[]"], ["comments.json", "[]"], ["stack.json", JSON.stringify({ below: [70], above: [] })]]) writeFileSync(join(s.r.dir, f!), t!)
    await cli(["github-status", "--repo", s.r.dir, "--policy-ref", s.base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--stack", "stack.json", "--out", "trusted"])
    expect(readFileSync(join(s.r.dir, "trusted", "gauntlet-report.md"), "utf8")).toContain("Delete each branch as it merges (`--delete-branch`): GitHub then moves the next pull request onto the default branch")
  })
})
