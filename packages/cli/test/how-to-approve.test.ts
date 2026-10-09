import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
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
    expect(md).toContain(`- [ ] **Approve this change** (commit \`${head.slice(0, 12)}\`)`)
    expect(md).toContain("Files changed, Review changes, Approve")
    expect(md).toContain(`comment \`/gauntlet approve ${head.slice(0, 12)}\``)
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

  test("ticking the box approves the commit, and the report then shows who ticked it", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 2 }\n" })
    const head = s.r.commit("change the money zone")
    await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", join(s.r.dir, "evidence"), "--no-record"])
    const box = `- [x] **Approve this change** (commit \`${head.slice(0, 12)}\`)`
    const decide = async (comments: unknown[]) => {
      writeFileSync(join(s.r.dir, "reviews.json"), "[]")
      writeFileSync(join(s.r.dir, "comments.json"), JSON.stringify(comments))
      await cli(["github-status", "--repo", s.r.dir, "--policy-ref", s.base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--out", "trusted"])
      return { status: JSON.parse(readFileSync(join(s.r.dir, "trusted", "status.json"), "utf8")), md: readFileSync(join(s.r.dir, "trusted", "gauntlet-report.md"), "utf8") }
    }
    // The workflow passes the edited report as from whoever ticked it.
    expect((await decide([{ user: "mallory", body: box }])).status.conclusion).toBe("action_required")
    const approved = await decide([{ user: "payments", body: box }])
    expect(approved.status.conclusion).toBe("success")
    expect(approved.md).toContain(`- [x] **Approve this change**: approved by payments (commit \`${head.slice(0, 12)}\`)`)
    // On a later run, Gauntlet's own comment still records the approval.
    const recorded = approved.md.split("\n").find((l) => l.startsWith("- [x]"))!
    expect((await decide([{ user: "github-actions[bot]", body: `<!-- gauntlet-report -->\n${recorded}` }])).status.conclusion).toBe("success")
    expect((await decide([{ user: "mallory", body: recorded }])).status.conclusion).toBe("action_required")
  })
})
