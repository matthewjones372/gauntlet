import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Approvals follow the code, not the commit (spec 0015). Rebasing a stack onto
// a main that took the part below it as a squash gives each pull request a new
// commit with the same code: the owner's approval carries over. A new commit
// with a different diff needs a new approval, as before.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const BOT = "github-actions[bot]"
const MARK = "<!-- gauntlet-report -->"

/** The trusted job on the current head, with the comments the pull request has; returns the status and the report it posts. */
const status = async (r: TempRepo, base: string, comments: object[], out: string) => {
  await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", join(r.dir, `${out}-evidence`), "--no-record"])
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  writeFileSync(join(r.dir, "comments.json"), JSON.stringify(comments))
  await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", `${out}-evidence/gauntlet-report.json`, "--reviews", "reviews.json", "--comments", "comments.json", "--out", out])
  const md = readFileSync(join(r.dir, out, "gauntlet-report.md"), "utf8")
  return { status: JSON.parse(readFileSync(join(r.dir, out, "status.json"), "utf8")), comment: { user: BOT, body: `${MARK}\n${md}` } }
}

/** An owner-tier change (the money zone) approved by its owner. */
const approved = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 1 }\n" })
  const head = s.r.commit("touch money")
  const first = await status(s.r, s.base, [{ user: "payments", body: `/gauntlet approve ${head.slice(0, 12)}` }], "t1")
  expect(first.status.conclusion).toBe("success")
  return { ...s, head, report: first.comment }
}

describe("an approval follows the code", () => {
  test("Gauntlet records the approved commit's tree and judged base", async () => {
    const { r, base, head, report } = await approved()
    const tree = r.git("rev-parse", `${head}^{tree}`)
    const baseTree = r.git("rev-parse", `${base}^{tree}`)
    // The tree and base ride in a comment GitHub doesn't show; people see who approved which commit.
    expect(report.body).toContain(`- [x] **Approve this change**: approved by payments (commit \`${head.slice(0, 12)}\`) <!-- tree ${tree} base ${baseTree} -->`)
  }, 60_000)

  test("a new commit with the same code keeps it, and says where it came from", async () => {
    const { r, base, head, report } = await approved()
    r.git("commit", "-q", "--amend", "-m", "touch money, reworded")
    const again = r.git("rev-parse", "HEAD")
    expect(again).not.toBe(head)
    const next = await status(r, base, [report], "t2")
    expect(next.status.conclusion).toBe("success")
    expect(next.status.summary).toContain(`The approval of ${head.slice(0, 12)} carries over: this commit has the same code, compared with the same base.`)
    // Recorded again for the new commit, so it carries on through the next one too.
    expect(next.comment.body).toContain(`(commit \`${again.slice(0, 12)}\`) <!-- tree `)
  }, 60_000)

  test("a new commit that changes the diff needs a new approval", async () => {
    const { r, base, report } = await approved()
    r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 2 }\n" })
    r.commit("change the rate")
    expect((await status(r, base, [report], "t2")).status.conclusion).toBe("action_required")
  }, 60_000)

  test("the same tree judged against another base needs a new approval", async () => {
    const { r, base, report } = await approved()
    // Main moves on, and the branch is merged up: a different base, and a different tree.
    r.git("checkout", "-q", "main")
    r.write({ "src/main/App.kt": "class App { val more = 1 }\n" })
    const moved = r.commit("main moves on")
    r.git("checkout", "-q", "feature")
    r.git("merge", "-q", "--no-edit", "main")
    expect((await status(r, moved, [report], "t2")).status.conclusion).toBe("action_required")
    expect(base).not.toBe(moved)
  }, 60_000)

  test("a stack rebased onto main after the part below merged as a squash keeps its approval", async () => {
    const s = baseRepo()
    repos.push(s.r)
    const r = s.r
    // Stack: part 1 on main, part 2 (owner tier) on part 1.
    r.write({ "src/main/App.kt": "class App { val one = 1 }\n" })
    const part1 = r.commit("part 1")
    r.git("checkout", "-q", "-b", "part2")
    r.write({ "src/money/Fx.kt": "class Fx { fun rate() = 1 }\n" })
    const part2 = r.commit("part 2")
    const first = await status(r, part1, [{ user: "payments", body: `/gauntlet approve ${part2.slice(0, 12)}` }], "t1")
    expect(first.status.conclusion).toBe("success")
    // Part 1 lands on main as a squash; part 2 is rebased onto main: a new commit, the same code.
    r.git("checkout", "-q", "main")
    r.git("merge", "-q", "--squash", "feature")
    r.git("commit", "-q", "-m", "part 1 (squashed)")
    const main = r.git("rev-parse", "HEAD")
    r.git("checkout", "-q", "part2")
    r.git("rebase", "-q", "--onto", "main", "feature")
    expect(r.git("rev-parse", "HEAD")).not.toBe(part2)
    const after = await status(r, main, [first.comment], "t2")
    expect(after.status.conclusion).toBe("success")
  }, 60_000)
})
