import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A change waiting for review says exactly how to approve it on GitHub,
// including when you opened the pull request yourself.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("how to approve", () => {
  test("a change at review tier says how to approve it, and the comment names its commit", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "src/main/behaviour.txt": "broken round\n", "src/test/RoundTest.txt": "bankers\n" })
    const head = s.r.commit("rounding changes, and its test with it")
    const out = join(s.r.dir, "out")
    await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", out])
    const md = readFileSync(join(out, "gauntlet-report.md"), "utf8")
    expect(md).toContain("### How to approve")
    expect(md).toContain("Files changed, Review changes, and chooses Approve")
    expect(md).toContain(`comments \`/gauntlet approve ${head.slice(0, 12)}\``)
  })

  test("a clean change that needs no approval says nothing about it", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "src/main/App.kt": "class App { fun hello() = 1 }\n" })
    s.r.commit("small change")
    const out = join(s.r.dir, "out")
    await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", out])
    expect(readFileSync(join(out, "gauntlet-report.md"), "utf8")).not.toContain("### How to approve")
  })
})
