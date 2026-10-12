import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// CI judges a pull request with its base's policy, so an override has to be
// recorded against that policy, even when the pull request edits it. One that
// isn't says why it doesn't count, and how to record it so it does.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** A pull request that edits the policy and breaks a test: blocked, at owner tier. */
const policyEditingChange = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({
    ".gauntlet/policy.gx": POLICY.replace(`fix "Add tests for the changed lines."`, `fix "Cover the changed lines with tests."`),
    "src/main/behaviour.txt": "broken add\n",
  })
  const head = s.r.commit("edit the policy and break a test")
  return { ...s, head }
}

/** What the trusted job decides for the head, as CI runs it: with the base's policy and the platform owner's approval. */
const judgeInCi = async (r: TempRepo, base: string, head: string) => {
  await cli(["check", "--repo", r.dir, "--policy-ref", base, "--head", head, "--out", join(r.dir, "evidence"), "--no-record"])
  writeFileSync(join(r.dir, "reviews.json"), JSON.stringify([{ user: "platform", state: "APPROVED", commitId: head }]))
  const res = await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", head, "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
  expect(res.code).not.toBe(2)
  return {
    status: JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")),
    md: readFileSync(join(r.dir, "trusted", "gauntlet-report.md"), "utf8"),
  }
}

const REASON = "the policy wording changes with this fix"

describe("an override on a pull request that edits the policy", () => {
  test("is recorded against the base's policy by default, so CI honours it once the owner approves", async () => {
    const { r, base, head } = policyEditingChange()
    const recorded = await cli(["override", "--repo", r.dir, "--reason", REASON, "--approver", "@platform"])
    expect(recorded.code).toBe(0)
    const { status } = await judgeInCi(r, base, head)
    expect(status.conclusion).toBe("success")
    expect(status.honouredOverrides).toEqual([expect.objectContaining({ approver: "@platform", reason: REASON })])
  })

  test("recorded against another policy, it isn't honoured and says exactly why and what to run", async () => {
    const { r, base, head } = policyEditingChange()
    // The head's own policy, which CI never judges with.
    expect((await cli(["override", "--repo", r.dir, "--policy-ref", "HEAD", "--reason", REASON, "--approver", "@platform"])).code).toBe(0)
    const { status, md } = await judgeInCi(r, base, head)
    expect(status.conclusion).toBe("failure")
    expect(status.honouredOverrides).toEqual([])
    // The check run says why and gives the owner's one-step fix; the report also names the base's commit.
    expect(status.summary).toContain(`recorded against the policy at ${head.slice(0, 12)}`)
    expect(status.summary).toContain(`gauntlet approve <pr> --override "<reason>" --head ${head.slice(0, 12)}`)
    expect(md).toContain(`recorded against the policy at ${head.slice(0, 12)}`)
    expect(md).toContain(`judged with the policy at ${base.slice(0, 12)}`)
    expect(md).toContain(`gauntlet override --policy-ref ${base.slice(0, 12)}`)
    expect(md).not.toContain("a local override is only recorded")
  })

  test("a local check, judged with the working copy's edited policy, doesn't call the right override wrong", async () => {
    const { r, base } = policyEditingChange()
    await cli(["override", "--repo", r.dir, "--reason", REASON, "--approver", "@platform"])
    const out = join(r.dir, "local")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", out])
    expect(readFileSync(join(out, "gauntlet-report.md"), "utf8")).not.toContain("recorded against")
  })

  test("still needs the named owner's approval of that exact commit", async () => {
    const { r, base, head } = policyEditingChange()
    await cli(["override", "--repo", r.dir, "--reason", REASON, "--approver", "@platform"])
    await cli(["check", "--repo", r.dir, "--policy-ref", base, "--head", head, "--out", join(r.dir, "evidence"), "--no-record"])
    writeFileSync(join(r.dir, "reviews.json"), JSON.stringify([{ user: "mallory", state: "APPROVED", commitId: head }]))
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", head, "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
    expect(JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")).conclusion).toBe("failure")
  })
})
