import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { agentSummary, renderAgentSummary } from "@gauntlet/core"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A change that needs a person says so, and says where: the agent asks for
// approval in plain words, the pull request's check and report name the
// zones it touches, and once approved the report says who approved it.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** A change to the money zone, whose owner is @payments. */
const zoneChange = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 2 }\n" })
  const head = s.r.commit("change the money zone")
  await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", join(s.r.dir, "evidence"), "--no-record"])
  return { ...s, head, evidence: JSON.parse(readFileSync(join(s.r.dir, "evidence", "gauntlet-report.json"), "utf8")) }
}
const status = async (r: TempRepo, base: string, comments: unknown[] = []) => {
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  writeFileSync(join(r.dir, "comments.json"), JSON.stringify(comments))
  await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--out", "trusted"])
  return {
    status: JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")),
    md: readFileSync(join(r.dir, "trusted", "gauntlet-report.md"), "utf8"),
  }
}

describe("a person in the loop", () => {
  test("the agent asks for approval in plain words and says where", async () => {
    const { evidence, head } = await zoneChange()
    const text = renderAgentSummary(agentSummary(evidence, "out"))
    expect(text).toContain(`"I need you to approve this change: it touches money."`)
    expect(text).toContain("- Zone money (owner @payments): src/money/Fx.kt")
    expect(text).toContain(`/gauntlet approve ${head.slice(0, 12)}`)
  })

  test("the pull request's check and report name the zone, its owner and files", async () => {
    const { r, base } = await zoneChange()
    const { status: s, md } = await status(r, base)
    expect(s.title).toBe("Needs an owner: touches money")
    expect(md).toContain("### Needs your attention")
    expect(md).toContain("- Zone **money** (owner @payments): `src/money/Fx.kt`")
  })

  test("once the owner approves, the check and the report say who", async () => {
    const { r, base, head } = await zoneChange()
    const { status: s, md } = await status(r, base, [{ user: "payments", body: `/gauntlet approve ${head.slice(0, 12)}` }])
    expect(s.conclusion).toBe("success")
    expect(s.title).toBe("Approved by payments (owner)")
    expect(md.split("\n").slice(0, 3).join("\n")).toContain(`**Approved by payments (owner)** for commit \`${head.slice(0, 12)}\`.`)
  })
})
