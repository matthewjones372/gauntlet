import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// Overrides follow the code like approvals do (spec 0015). An owner's override
// is recorded for one commit; a new commit with the same code (a merge from the
// base that brought nothing new, a reworded commit) keeps it along with the
// approval. A new commit that changes the diff needs both again.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const BOT = "github-actions[bot]"
const MARK = "<!-- gauntlet-report -->"
const REASON = "the broken behaviour ships behind a flag today"

/** The trusted job on the current head, with the comments the pull request has; returns the status and the report it posts. */
const status = async (r: TempRepo, base: string, comments: object[], out: string) => {
  await cli(["check", "--repo", r.dir, "--policy-ref", base, "--out", join(r.dir, `${out}-evidence`), "--no-record"])
  writeFileSync(join(r.dir, "reviews.json"), "[]")
  writeFileSync(join(r.dir, "comments.json"), JSON.stringify(comments))
  await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", `${out}-evidence/gauntlet-report.json`, "--reviews", "reviews.json", "--comments", "comments.json", "--out", out])
  const md = readFileSync(join(r.dir, out, "gauntlet-report.md"), "utf8")
  return { status: JSON.parse(readFileSync(join(r.dir, out, "status.json"), "utf8")), comment: { user: BOT, body: `${MARK}\n${md}` } }
}

/** A blocked change the owner overrode and approved: the report Gauntlet posted records the approval with its code. */
const overridden = async () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/main/behaviour.txt": "broken add\n" })
  const head = s.r.commit("break a test")
  expect((await cli(["override", "--repo", s.r.dir, "--base", s.base, "--reason", REASON, "--approver", "@platform"])).code).toBe(0)
  const first = await status(s.r, s.base, [{ user: "platform", body: `/gauntlet approve ${head.slice(0, 12)}` }], "t1")
  expect(first.status.conclusion).toBe("success")
  return { ...s, head, report: first.comment }
}

describe("an override follows the code", () => {
  test("a new commit with the same code keeps it, with the approval, and says so", async () => {
    const { r, base, head, report } = await overridden()
    r.git("commit", "-q", "--amend", "-m", "break a test, reworded")
    expect(r.git("rev-parse", "HEAD")).not.toBe(head)
    const next = await status(r, base, [report], "t2")
    expect(next.status.conclusion).toBe("success")
    expect(next.status.honouredOverrides).toEqual([expect.objectContaining({ headSha: head, approver: "@platform", reason: REASON })])
    expect(next.status.summary).toContain(`The override recorded for ${head.slice(0, 12)} carries over too.`)
  }, 60_000)

  test("a new commit that changes the diff is blocked again", async () => {
    const { r, base, report } = await overridden()
    r.write({ "src/main/behaviour.txt": "broken add, and more\n" })
    r.commit("change it again")
    const next = await status(r, base, [report], "t2")
    expect(next.status.conclusion).toBe("failure")
    expect(next.status.honouredOverrides).toEqual([])
  }, 60_000)

  test("without the owner's recorded approval of the earlier commit, its override stays there", async () => {
    const { r, base } = await overridden()
    r.git("commit", "-q", "--amend", "-m", "break a test, reworded")
    // Only the owner's comment naming the earlier commit: it names a commit, not code, so nothing carries.
    const next = await status(r, base, [], "t2")
    expect(next.status.conclusion).toBe("failure")
    expect(next.status.honouredOverrides).toEqual([])
  }, 60_000)
})
