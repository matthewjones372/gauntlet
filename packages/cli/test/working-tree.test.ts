import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo, cli } from "./harness.ts"

// Agents rarely commit before they stop, so the Stop hook and `check
// --working-tree` judge uncommitted and new files, and `report blocked` is the
// agent's way out.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const setup = () => {
  const s = baseRepo()
  repos.push(s.r)
  return s
}
const stop = (r: TempRepo) => hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir }))

describe("judging the working tree", () => {
  test("the Stop hook blocks an uncommitted failing change", async () => {
    const { r } = setup()
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken add\n")
    const out = JSON.parse((await stop(r)).out)
    expect(out.decision).toBe("block")
    expect(out.reason).toContain("unit failed")
    expect(r.git("status", "--porcelain")).toBe("M src/main/behaviour.txt")
  })

  test("check --working-tree includes new files; plain check judges HEAD", async () => {
    const { r, base } = setup()
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken round\n")
    const tree = await cli(["check", "--repo", r.dir, "--base", base, "--working-tree", "--json", "--out", join(r.dir, ".git", "out-tree")])
    expect(tree.code).toBe(1)
    const head = await cli(["check", "--repo", r.dir, "--base", base, "--json", "--no-record", "--out", join(r.dir, ".git", "out-commit")])
    expect(JSON.parse(head.out).decision.wouldBlock).toBe(false)
  })

  test("after report blocked the agent may stop, until it edits again", async () => {
    const { r } = setup()
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken add\n")
    const reported = await cli(["report", "blocked", "--repo", r.dir, "--reason", "Adding needs the AddTest expectation changed for the new rule.", "--path", "src/test/AddTest.txt"])
    expect(reported.code).toBe(0)
    expect(reported.out).toContain("Stop here and tell the person")
    expect((await stop(r)).out).toBe("")
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken add and more\n")
    expect(JSON.parse((await stop(r)).out).decision).toBe("block")
  })

  test("report blocked wants a reason a person can act on", async () => {
    const { r } = setup()
    const res = await cli(["report", "blocked", "--repo", r.dir, "--reason", "stuck"])
    expect(res.code).toBe(2)
    expect(res.err).toContain("Give a reason a person can act on")
  })
})
