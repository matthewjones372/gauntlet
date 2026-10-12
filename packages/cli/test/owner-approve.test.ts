import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { answers } from "../src/index.ts"
import { baseRepo, cli } from "./harness.ts"
import { fakeForge, type ForgeCall, ownerCli } from "./owner-harness.ts"

// `gauntlet approve <pr>` (spec 0015): one command per owner decision. It
// approves the pull request's current head as the owner, and with --override
// records the override for that commit and pushes the note first, so the one
// approval comment re-runs the check with both. It never runs for an agent.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** A pull request whose change fails a gate: blocked until an owner overrides it. */
const blockedChange = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write({ "src/main/behaviour.txt": "broken add\n" })
  const head = s.r.commit("break add")
  const pr = { number: 7, state: "OPEN", title: "Break add", url: "https://github.com/o/r/pull/7", headRefOid: head, headRefName: "feature", baseRefOid: s.base, baseRefName: "main" }
  return { ...s, head, pr }
}

const notes = (r: TempRepo, head: string) => {
  try {
    return r.git("notes", "--ref", "gauntlet-overrides", "show", head)
  } catch {
    return ""
  }
}

describe("gauntlet approve", () => {
  test("posts the owner's approval of the head commit it was shown", async () => {
    const { r, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    const res = await ownerCli(["approve", "7", "--head", head.slice(0, 12), "--repo", r.dir], { forge: fakeForge(pr, "platform", calls) })
    expect(res.code).toBe(0)
    expect(calls.filter((c) => c.op !== "fetch")).toEqual([{ op: "comment", pr: 7, body: `/gauntlet approve ${head}` }])
    expect(res.out).toContain(`Approved #7 at ${head.slice(0, 12)} as @platform.`)
  }, 60_000)

  test("--override records the override for that commit and pushes it before approving, so the check runs once", async () => {
    const { r, base, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    const res = await ownerCli(["approve", "7", "--head", head, "--override", "the add test is broken on main too", "--repo", r.dir], { forge: fakeForge(pr, "platform", calls) })
    expect(res.code).toBe(0)
    expect(calls.map((c) => c.op)).toEqual(["fetch", "fetch", "push", "comment"])
    expect(calls[2]).toEqual({ op: "push", refspec: "refs/notes/gauntlet-overrides" })
    const note = JSON.parse(notes(r, head))
    expect(note).toMatchObject({ headSha: head, reason: "the add test is broken on main too", approver: "@platform", requestedBy: "platform" })

    // The check that comment starts honours the override: the owner approved this commit.
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
    writeFileSync(join(r.dir, "reviews.json"), "[]")
    writeFileSync(join(r.dir, "comments.json"), JSON.stringify([{ user: "platform", body: (calls[3] as { body: string }).body }]))
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--comments", "comments.json", "--out", "trusted"])
    const status = JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8"))
    expect(status.conclusion).toBe("success")
    expect(status.honouredOverrides.map((o: { approver: string }) => o.approver)).toEqual(["@platform"])
  }, 60_000)

  test("a blocked check tells the owner the one command", async () => {
    const { r, base, head } = blockedChange()
    await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
    writeFileSync(join(r.dir, "reviews.json"), "[]")
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
    const status = JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8"))
    expect(status.conclusion).toBe("failure")
    expect(status.summary).toContain(`runs \`gauntlet approve <pr> --override "<reason>" --head ${head.slice(0, 12)}\`, which records the override for this commit, pushes it and approves, in one step.`)
  }, 60_000)

  test("without --head it shows the head and asks first", async () => {
    const { r, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    const declined = await ownerCli(["approve", "7", "--repo", r.dir], { forge: fakeForge(pr, "platform", calls), extra: answers("n") })
    expect(declined.code).toBe(2)
    expect(declined.out).toContain(`#7 Break add\n  head ${head.slice(0, 12)}`)
    expect(calls).toEqual([])
    const accepted = await ownerCli(["approve", "7", "--repo", r.dir], { forge: fakeForge(pr, "platform", calls), extra: answers("y") })
    expect(accepted.code).toBe(0)
    expect(calls.filter((c) => c.op !== "fetch")).toEqual([{ op: "comment", pr: 7, body: `/gauntlet approve ${head}` }])
  }, 60_000)

  test("refuses when the head moved since the owner looked", async () => {
    const { r, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    r.write({ "src/main/App.kt": "class App { val sneaky = 1 }\n" })
    const moved = r.commit("pushed after the owner looked")
    const res = await ownerCli(["approve", "7", "--head", head.slice(0, 12), "--override", "the add test is broken on main too", "--repo", r.dir], { forge: fakeForge({ ...pr, headRefOid: moved }, "platform", calls) })
    expect(res.code).toBe(2)
    expect(res.err).toContain(`#7's head is now ${moved.slice(0, 12)}, not ${head.slice(0, 12)}`)
    expect(calls).toEqual([])
    expect(notes(r, moved)).toBe("")
  }, 60_000)

  test("refuses a pull request that isn't open, and someone gh isn't signed in as an owner", async () => {
    const { r, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    const closed = await ownerCli(["approve", "7", "--head", head, "--repo", r.dir], { forge: fakeForge({ ...pr, state: "CLOSED" }, "platform", calls) })
    expect(closed.code).toBe(2)
    expect(closed.err).toContain("#7 is closed")
    const stranger = await ownerCli(["approve", "7", "--head", head, "--repo", r.dir], { forge: fakeForge(pr, "mallory", calls) })
    expect(stranger.code).toBe(2)
    expect(stranger.err).toContain("gh is signed in as @mallory, who isn't an owner (@payments, @platform)")
    expect(calls.filter((c) => c.op !== "fetch")).toEqual([])
  }, 60_000)

  test("a short override reason is refused before anything is posted", async () => {
    const { r, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    const res = await ownerCli(["approve", "7", "--head", head, "--override", "ok", "--repo", r.dir], { forge: fakeForge(pr, "platform", calls) })
    expect(res.code).toBe(2)
    expect(res.err).toContain("give a reason of at least 10 characters")
    expect(calls.filter((c) => c.op !== "fetch")).toEqual([])
  }, 60_000)
})

describe("an agent can't approve", () => {
  for (const marker of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CURSOR_AGENT", "GEMINI_CLI", "GAUNTLET_AGENT"]) {
    test(`with ${marker} set nothing is approved, overridden or pushed`, async () => {
      const { r, head, pr } = blockedChange()
      const calls: ForgeCall[] = []
      const res = await ownerCli(["approve", "7", "--head", head, "--override", "the add test is broken on main too", "--repo", r.dir], {
        forge: fakeForge(pr, "platform", calls),
        session: { env: { [marker]: "1" }, interactive: true },
      })
      expect(res.code).toBe(2)
      expect(res.err).toContain(`approving is the owner's decision, and ${marker} is set`)
      expect(calls).toEqual([])
      expect(notes(r, head)).toBe("")
    }, 60_000)
  }

  test("nor can anything without a terminal", async () => {
    const { r, head, pr } = blockedChange()
    const calls: ForgeCall[] = []
    const res = await ownerCli(["approve", "7", "--head", head, "--repo", r.dir], { forge: fakeForge(pr, "platform", calls), session: { env: {}, interactive: false } })
    expect(res.code).toBe(2)
    expect(res.err).toContain("needs the owner at a terminal")
    expect(calls).toEqual([])
  }, 60_000)
})
