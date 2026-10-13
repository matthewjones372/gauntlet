import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// The Stop hook's bounded exit (ADR 0026, spec 0018): blocked stops are
// counted per branch, and past the policy's limits the agent may stop as
// exhausted. Exhausted is never a pass: `check` and the GitHub job don't read it.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const setup = (policy = POLICY) => {
  const s = baseRepo()
  repos.push(s.r)
  if (policy !== POLICY) {
    // The limits come from the base policy, so they go in on main.
    s.r.git("checkout", "-q", "main")
    s.r.write({ ".gauntlet/policy.gx": policy })
    const base = s.r.commit("limits")
    s.r.git("checkout", "-q", "-B", "feature")
    return { r: s.r, base }
  }
  return s
}

const stop = async (cwd: string, event: "Stop" | "SubagentStop" = "Stop") => {
  const res = await hookCli(["hook", "stop"], JSON.stringify({ cwd, hook_event_name: event, stop_hook_active: true }))
  return res.out === "" ? {} : JSON.parse(res.out) as { decision?: string; reason?: string; systemMessage?: string }
}

const status = async (dir: string) => JSON.parse((await cli(["hook", "status", "--repo", dir, "--json"])).out).branches as Array<Record<string, any>>

const attemptsDir = (r: TempRepo) => join(r.dir, ".git", "gauntlet", "attempts")
const recordFile = (r: TempRepo, branch: string) => join(attemptsDir(r), `${Buffer.from(branch).toString("hex")}.json`)

describe("a worker that never fixes the finding", () => {
  test("is blocked three times on the same findings, then stops as exhausted", async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    for (const n of [1, 2, 3]) {
      const out = await stop(r.dir)
      expect(out.decision).toBe("block")
      expect(out.reason).toContain(`Gauntlet attempt ${n} of 3 on these findings, ${n} of 8 on this branch.`)
    }
    // The last block warns that the next stop on the same findings ends the attempt.
    const third = JSON.parse(readFileSync(recordFile(r, "feature"), "utf8"))
    expect(third.status).toBe("blocked")
    const out = await stop(r.dir)
    expect(out.decision).toBeUndefined()
    expect(out.systemMessage).toBe("Gauntlet: exhausted on feature (blocked 3 times in a row on the same findings). The change still fails its checks; details: gauntlet hook status --json")
    const [record] = await status(r.dir)
    expect(record).toMatchObject({ status: "exhausted", branch: "feature", attempts: { unchanged: 4, total: 4 }, limits: { unchanged: 3, total: 8 }, state: "ok" })
    expect(record!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(record!.findings).toContain("gate unit failed")
    expect(record!.findings).toContain("test unit svc.AddTest.add")
    expect(record!.reasons.join("\n")).toContain("unit failed")
    // Stopping again on an exhausted branch stays exhausted.
    expect((await stop(r.dir)).systemMessage).toContain("exhausted on feature")
  }, 120_000)

  test("the block before the last one says what the next stop means", async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    await stop(r.dir)
    expect((await stop(r.dir)).reason).not.toContain("exhausted")
    expect((await stop(r.dir)).reason).toContain("If your next stop finds the same, Gauntlet lets you stop as exhausted. That is still a failure")
  }, 120_000)

  test("an exhausted branch still fails gauntlet check and the GitHub job", async () => {
    const { r, base } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    for (let i = 0; i < 4; i++) await stop(r.dir)
    expect((await status(r.dir))[0]!.status).toBe("exhausted")
    const checked = await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
    expect(checked.code).toBe(1)
    const report = JSON.parse(readFileSync(join(r.dir, "evidence", "gauntlet-report.json"), "utf8"))
    expect(report.decision.blocking).toBe(true)
    expect(JSON.stringify(report)).not.toContain("exhausted")
    writeFileSync(join(r.dir, "reviews.json"), "[]")
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
    expect(JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")).conclusion).toBe("failure")
    // Even an approval doesn't satisfy anything for a blocked change.
    writeFileSync(join(r.dir, "reviews.json"), JSON.stringify([{ user: "alice", state: "APPROVED", commitId: r.git("rev-parse", "HEAD") }]))
    await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "evidence/gauntlet-report.json", "--reviews", "reviews.json", "--out", "trusted"])
    expect(JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")).conclusion).toBe("failure")
  }, 120_000)
})

describe("a worker that changes the findings every time", () => {
  test("resets the unchanged count but hits the policy's total cap", async () => {
    const { r } = setup(POLICY.replace("predicate small", "attempts { unchanged 2, total 4 }\npredicate small"))
    const breakages = ["broken add\n", "broken round\n", "broken add\n", "broken round\n"]
    for (const [i, b] of breakages.entries()) {
      r.write({ "src/main/behaviour.txt": b })
      const out = await stop(r.dir)
      expect(out.decision).toBe("block")
      expect(out.reason).toContain(`Gauntlet attempt 1 of 2 on these findings, ${i + 1} of 4 on this branch.`)
    }
    r.write({ "src/main/behaviour.txt": "broken add round\n" })
    const out = await stop(r.dir)
    expect(out.systemMessage).toBe("Gauntlet: exhausted on feature (blocked 4 times on this branch). The change still fails its checks; details: gauntlet hook status --json")
    expect((await status(r.dir))[0]).toMatchObject({ status: "exhausted", attempts: { unchanged: 1, total: 5 }, limits: { unchanged: 2, total: 4 } })
  }, 120_000)

  test("a pass clears the branch's attempts", async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    await stop(r.dir)
    await stop(r.dir)
    r.write({ "src/main/behaviour.txt": "all good, add fixed\n" })
    expect(await stop(r.dir)).toEqual({})
    expect(await status(r.dir)).toEqual([])
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    expect((await stop(r.dir)).reason).toContain("Gauntlet attempt 1 of 3")
  }, 120_000)
})

describe("tampering with the attempt record never buys attempts", () => {
  const blockedOnce = async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    expect((await stop(r.dir)).decision).toBe("block")
    return r
  }
  const ref = `refs/gauntlet/attempts/${Buffer.from("feature").toString("hex")}`

  test("deleting it: the next blocked stop is exhausted, not a fresh start", async () => {
    const r = await blockedOnce()
    r.remove(".git/gauntlet/attempts/" + Buffer.from("feature").toString("hex") + ".json")
    expect(await status(r.dir)).toEqual([{ branch: "feature", state: "missing" }])
    const out = await stop(r.dir)
    expect(out.systemMessage).toContain("its attempt record was missing")
    expect((await status(r.dir))[0]).toMatchObject({ status: "exhausted", state: "missing", attempts: { unchanged: 4, total: 9 } })
  }, 120_000)

  test("corrupting it: exhausted, not a fresh start", async () => {
    const r = await blockedOnce()
    writeFileSync(recordFile(r, "feature"), "{ not json")
    expect((await stop(r.dir)).systemMessage).toContain("its attempt record was unreadable or didn't match its witness")
  }, 120_000)

  test("forging a lower count: the witness no longer matches, so exhausted", async () => {
    const r = await blockedOnce()
    await stop(r.dir)
    const record = JSON.parse(readFileSync(recordFile(r, "feature"), "utf8"))
    writeFileSync(recordFile(r, "feature"), `${JSON.stringify({ ...record, attempts: { unchanged: 0, total: 0 } }, null, 2)}\n`)
    expect((await stop(r.dir)).systemMessage).toContain("didn't match its witness")
  }, 120_000)

  test("deleting the witness ref: exhausted; deleting both is a fresh branch", async () => {
    const r = await blockedOnce()
    r.git("update-ref", "-d", ref)
    expect((await stop(r.dir)).systemMessage).toContain("exhausted on feature")
    r.git("update-ref", "-d", ref)
    r.remove(".git/gauntlet/attempts/" + Buffer.from("feature").toString("hex") + ".json")
    expect((await stop(r.dir)).reason).toContain("Gauntlet attempt 1 of 3")
  }, 120_000)

  test("a person's reset starts the count again", async () => {
    const r = await blockedOnce()
    for (let i = 0; i < 3; i++) await stop(r.dir)
    expect((await status(r.dir))[0]!.status).toBe("exhausted")
    expect((await cli(["hook", "reset", "--repo", r.dir])).out).toBe("Cleared the attempts recorded for feature.")
    expect((await stop(r.dir)).reason).toContain("Gauntlet attempt 1 of 3")
  }, 120_000)

  test("the agent's hook refuses to touch the record, its witness or the reset", async () => {
    const r = await blockedOnce()
    const decide = async (input: Record<string, unknown>) => {
      const out = (await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, ...input }))).out
      return out === "" ? "allow" : JSON.parse(out).hookSpecificOutput.permissionDecision
    }
    expect(await decide({ tool_name: "Bash", tool_input: { command: "rm -rf .git/gauntlet/attempts" } })).toBe("deny")
    expect(await decide({ tool_name: "Bash", tool_input: { command: `git update-ref -d ${ref}` } })).toBe("deny")
    expect(await decide({ tool_name: "Bash", tool_input: { command: "gauntlet hook reset" } })).toBe("deny")
    expect(await decide({ tool_name: "Write", tool_input: { file_path: recordFile(r, "feature") } })).toBe("deny")
    expect(await decide({ tool_name: "Bash", tool_input: { command: "gauntlet hook status --json" } })).toBe("allow")
  }, 120_000)
})

describe("reported-blocked and exhausted are different outcomes", () => {
  test("a matching report_blocked is waiting on the owner and doesn't count", async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    await stop(r.dir)
    await cli(["report", "blocked", "--repo", r.dir, "--reason", "The test setup in scripts/test.sh needs a new fixture."])
    for (let i = 0; i < 5; i++) expect((await stop(r.dir)).decision).toBeUndefined()
    const [record] = await status(r.dir)
    expect(record).toMatchObject({ status: "reported-blocked", attempts: { unchanged: 1, total: 1 }, reportedReason: "The test setup in scripts/test.sh needs a new fixture." })
    // Any other edit makes the report stale, and counting picks up where it was.
    r.write({ "src/main/App.kt": "class App { }\n" })
    expect((await stop(r.dir)).reason).toContain("Gauntlet attempt 2 of 3")
  }, 120_000)
})

describe("SubagentStop and worktrees", () => {
  test("each subagent is judged on its own worktree and counted on its own branch", async () => {
    const { r } = setup()
    const other = join(r.dir, "..", `${r.dir.split("/").pop()}-other`)
    r.git("worktree", "add", "-q", "-b", "other", other, "main")
    try {
      // The main checkout breaks one test; the worktree passes until it breaks another.
      r.write({ "src/main/behaviour.txt": "broken add\n" })
      const sub = await stop(other, "SubagentStop")
      expect(sub).toEqual({})
      writeFileSync(join(other, "src/main/behaviour.txt"), "broken round\n")
      mkdirSync(join(other, "src/main/deep"), { recursive: true })
      const fromSubdir = await stop(join(other, "src/main/deep"), "SubagentStop")
      expect(fromSubdir.decision).toBe("block")
      expect(fromSubdir.reason).toContain("RoundTest")
      expect(fromSubdir.reason).not.toContain("AddTest")
      const main = await stop(r.dir, "SubagentStop")
      expect(main.reason).toContain("AddTest")
      const views = await status(r.dir)
      expect(views.map((v) => `${v.branch} ${v.status} ${v.attempts.total}`)).toEqual(["feature blocked 1", "other blocked 1"])
      expect(views.find((v) => v.branch === "other")!.findings).toContain("test unit svc.RoundTest.round")
      // One store for the repository, in the common git directory, and none in the worktree.
      expect(readdirSync(attemptsDir(r)).sort()).toEqual([`${Buffer.from("feature").toString("hex")}.json`, `${Buffer.from("other").toString("hex")}.json`].sort())
      expect(existsSync(join(other, ".git", "gauntlet"))).toBe(false)
      expect(await status(other)).toEqual(views)
      // The worktree's agent can't reach the record either, though it's outside its checkout.
      const denied = (await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: other, tool_name: "Edit", tool_input: { file_path: recordFile(r, "other") } }))).out
      expect(JSON.parse(denied).hookSpecificOutput.permissionDecision).toBe("deny")
    } finally {
      r.git("worktree", "remove", "--force", other)
    }
  }, 120_000)
})
