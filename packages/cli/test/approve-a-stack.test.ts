import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A stack of pull requests is approved from the top: the top's report warns
// that its box approves every pull request under it, and a pull request under
// it is approved by the owner's tick up there, saying so.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

// A change in the money zone (owner @payments): the owner tier.
const ownerTierChange = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 1 }\n" })
  const head = s.r.commit("touch money")
  await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", join(s.r.dir, "evidence"), "--no-record"])
  return { ...s, head }
}

const status = async (r: TempRepo, base: string, stack: object) => {
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  writeFileSync(join(r.dir, "comments.json"), "[]")
  writeFileSync(join(r.dir, "stack.json"), JSON.stringify(stack))
  await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--stack", "stack.json", "--out", "trusted"])
  return { status: JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")), md: readFileSync(join(r.dir, "trusted", "gauntlet-report.md"), "utf8") }
}

describe("approving a stack", () => {
  test("the top's report warns, above its box, that ticking it approves everything under it", async () => {
    const { r, base } = await ownerTierChange()
    const { md } = await status(r, base, { below: [70, 71], above: [] })
    const warning = md.indexOf("This pull request is the top of a stack: #70, #71 are under it. Ticking the box approves all of them too")
    expect(warning).toBeGreaterThan(0)
    expect(warning).toBeLessThan(md.indexOf("- [ ] **Approve this change**"))
    expect(md).toContain("Merge the stack bottom first with merge commits (`gh pr merge --merge`)")
  })

  test("a pull request under it is approved by the owner's tick at the top, and says so", async () => {
    const { r, base } = await ownerTierChange()
    const top = "cccccccccccc0000000000000000000000000000"
    const tick = { user: "github-actions[bot]", editor: "payments", body: `<!-- gauntlet-report -->\n- [x] **Approve this change** (commit \`${top.slice(0, 12)}\`)` }
    const { status: s, md } = await status(r, base, { below: [], above: [{ number: 72, head: top, contains: true, comments: [tick] }] })
    expect(s.conclusion).toBe("success")
    expect(s.approvedVia).toEqual([72])
    expect(s.summary).toContain("Approved with its stack: the box was ticked on #72, whose commit contains this one.")
    expect(md).toContain("Approved with its stack: the box was ticked on #72, whose commit contains this one.")
  })

  test("a tick on a pull request that doesn't contain it leaves it waiting", async () => {
    const { r, base } = await ownerTierChange()
    const top = "cccccccccccc0000000000000000000000000000"
    const tick = { user: "github-actions[bot]", editor: "payments", body: `<!-- gauntlet-report -->\n- [x] **Approve this change** (commit \`${top.slice(0, 12)}\`)` }
    expect((await status(r, base, { below: [], above: [{ number: 80, head: top, contains: false, comments: [tick] }] })).status.conclusion).toBe("action_required")
  })
})
