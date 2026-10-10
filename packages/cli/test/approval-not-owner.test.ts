import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Someone with write access to the repository who isn't an owner can tick the
// box, edit Gauntlet's comment or edit an owner's old approval: none of it
// turns the check green. The report posted again has the box unticked and
// says why, and the owner's own tick then approves the commit.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const BOT = "github-actions[bot]"
const MARK = "<!-- gauntlet-report -->"

// A change in the money zone (owner @payments): the owner tier.
const ownerTierChange = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 1 }\n" })
  const head = s.r.commit("touch money")
  await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", join(s.r.dir, "evidence"), "--no-record"])
  return { ...s, head, short: head.slice(0, 12) }
}

const status = async (r: TempRepo, base: string, comments: object[]) => {
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  writeFileSync(join(r.dir, "comments.json"), JSON.stringify(comments))
  await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--out", "trusted"])
  return {
    status: JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")),
    md: readFileSync(join(r.dir, "trusted", "gauntlet-report.md"), "utf8"),
  }
}

describe("someone with write access who isn't an owner", () => {
  test("ticking the box doesn't turn the check green; the box comes back unticked, saying why", async () => {
    const { r, base, short } = await ownerTierChange()
    const { status: s, md } = await status(r, base, [{ user: BOT, editor: "mallory", body: `${MARK}\n- [x] **Approve this change** (commit \`${short}\`)` }])
    expect(s.conclusion).toBe("action_required")
    expect(s.title).toStartWith("Needs an owner")
    expect(s.notOwners).toEqual(["mallory"])
    expect(s.summary).toContain("@mallory ticked the box or approved, but only an owner (@payments, @platform) can approve, so it doesn't count.")
    expect(md).toContain("> @mallory ticked the box or approved, but isn't an owner, so it doesn't count. An owner ticks the box below.")
    expect(md).toContain(`- [ ] **Approve this change** (commit \`${short}\`)`)
  })

  test("writing an approval record into Gauntlet's comment doesn't turn it green", async () => {
    const { r, base, short } = await ownerTierChange()
    const { status: s } = await status(r, base, [{ user: BOT, editor: "mallory", body: `${MARK}\n- [x] **Approve this change**: approved by payments (commit \`${short}\`)` }])
    expect(s.conclusion).toBe("action_required")
  })

  test("editing an owner's old approval to name this commit doesn't turn it green", async () => {
    const { r, base, short } = await ownerTierChange()
    const { status: s } = await status(r, base, [{ user: "payments", editor: "mallory", body: `/gauntlet approve ${short}` }])
    expect(s.conclusion).toBe("action_required")
  })

  test("then the owner ticks the box, and the check turns green, naming them", async () => {
    const { r, base, short } = await ownerTierChange()
    const { status: s, md } = await status(r, base, [{ user: BOT, editor: "payments", body: `${MARK}\n- [x] **Approve this change** (commit \`${short}\`)` }])
    expect(s.conclusion).toBe("success")
    expect(s.title).toBe("Approved by payments (owner)")
    expect(s.notOwners).toBeUndefined()
    expect(md).toContain(`- [x] **Approve this change**: approved by payments (commit \`${short}\`)`)
  })
})
