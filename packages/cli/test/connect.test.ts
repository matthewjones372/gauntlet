import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo, cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const setup = () => {
  const s = baseRepo()
  repos.push(s.r)
  return s
}

// The evidence job's report, as the untrusted job would upload it.
const evidenceFor = async (r: TempRepo, base: string) => {
  await cli(["check", "--repo", r.dir, "--base", base, "--out", join(r.dir, "evidence"), "--no-record"])
  return JSON.parse(readFileSync(join(r.dir, "evidence", "gauntlet-report.json"), "utf8"))
}

const status = async (r: TempRepo, base: string, evidence: unknown, reviews: unknown[] = []) => {
  writeFileSync(join(r.dir, "forged.json"), JSON.stringify(evidence))
  writeFileSync(join(r.dir, "reviews.json"), JSON.stringify(reviews))
  const res = await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "forged.json", "--reviews", "reviews.json", "--out", "trusted"])
  return {
    ...res,
    status: JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")),
    report: JSON.parse(readFileSync(join(r.dir, "trusted", "gauntlet-report.json"), "utf8")),
  }
}

describe("github-status recomputes what needs no execution", () => {
  test("forged evidence can't hide an integrity finding or a protected change", async () => {
    const { r, base } = setup()
    r.write({ "scripts/build.sh": "exit 0 # tweak\n" })
    r.git("rm", "-q", "src/test/RoundTest.txt")
    r.commit("tampers")
    const evidence = await evidenceFor(r, base)
    const forged = {
      ...evidence,
      decision: { ...evidence.decision, tier: "auto", blocking: false, wouldBlock: false, nominations: [] },
      facts: { ...evidence.facts, protectedTouched: [] },
      integrity: { findings: [], notExecuted: [] },
    }
    const { status: s, report } = await status(r, base, forged)
    expect(s.conclusion).toBe("failure")
    expect(report.integrity.findings.map((f: { check: string }) => f.check)).toEqual(["deleted-tests"])
    expect(report.facts.protectedTouched.map((p: { path: string }) => p.path)).toEqual(["scripts/build.sh", "src/test/RoundTest.txt"])
    expect(report.decision.tier).toBe("review")
  })

  test("a check missing from the evidence counts as not executed", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("clean")
    const evidence = await evidenceFor(r, base)
    expect((await status(r, base, evidence)).status.conclusion).toBe("success")
    const withoutUnit = { ...evidence, checks: evidence.checks.filter((c: { check: string }) => c.check !== "unit") }
    const { status: s, report } = await status(r, base, withoutUnit)
    expect(report.checks.find((c: { check: string }) => c.check === "unit")).toMatchObject({ status: "not-executed", reason: "the evidence job reported no outcome for this check" })
    expect(s.conclusion).not.toBe("success")
  })

  test("a gate failure in the evidence is honoured, and missing evidence doesn't pass", async () => {
    const { r, base } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    expect((await status(r, base, await evidenceFor(r, base))).status.conclusion).toBe("failure")
    const missing = await cli(["github-status", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD", "--evidence", "nope.json", "--reviews", "nope.json", "--out", "trusted"])
    expect(missing.err).toContain("No readable evidence report")
    expect(JSON.parse(readFileSync(join(r.dir, "trusted", "status.json"), "utf8")).conclusion).not.toBe("success")
  })

  test("review tier passes once someone approves the head commit", async () => {
    const { r, base } = setup()
    r.write({ "scripts/build.sh": "exit 0 # tweak\n" })
    const head = r.commit("touches config")
    const evidence = await evidenceFor(r, base)
    expect((await status(r, base, evidence)).status.conclusion).toBe("action_required")
    expect((await status(r, base, evidence, [{ user: "alice", state: "APPROVED", commitId: head }])).status.conclusion).toBe("success")
  })
})

describe("gauntlet hook stop", () => {
  test("stays quiet when it already blocked this stop", async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    expect((await hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir, stop_hook_active: true }))).out).toBe("")
  })

  test("blocks with the reasons and a way out while the change would be blocked", async () => {
    const { r } = setup()
    r.write({ "src/main/behaviour.txt": "broken add\n" })
    r.commit("breaks a test")
    const out = JSON.parse((await hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir }))).out)
    expect(out.decision).toBe("block")
    expect(out.reason).toContain("Gauntlet would block this change")
    expect(out.reason).toContain("report_blocked")
  })

  test("lets a passing change stop, and doesn't trap the agent where Gauntlet can't run", async () => {
    const { r } = setup()
    r.write({ "src/main/App.kt": "class App { fun a() = 1 }\n" })
    r.commit("clean")
    expect((await hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir }))).out).toBe("")
    expect((await hookCli(["hook", "stop"], JSON.stringify({ cwd: "/" }))).out).toBe("")
  })
})

describe("gauntlet hook pre-tool-use", () => {
  const decide = async (r: TempRepo, file_path: string, tool_name = "Edit") => {
    const out = (await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, tool_name, tool_input: { file_path } }))).out
    return out === "" ? "allow" : JSON.parse(out).hookSpecificOutput.permissionDecision
  }

  test("denies edits to existing protected files and the policy", async () => {
    const { r } = setup()
    expect(await decide(r, join(r.dir, "scripts/lint.sh"))).toBe("deny")
    expect(await decide(r, "scripts/build.sh", "Write")).toBe("deny")
    expect(await decide(r, join(r.dir, ".gauntlet/policy.gx"))).toBe("deny")
    expect(await decide(r, join(r.dir, "scripts/new/dir/tool.sh"), "Write")).toBe("deny")
  })

  test("allows new test files, main code and paths outside the repo", async () => {
    const { r } = setup()
    // A changed requirement changes its tests: the edit is allowed, and the check sends the change to review.
    expect(await decide(r, join(r.dir, "src/test/AddTest.txt"))).toBe("allow")
    expect(await decide(r, join(r.dir, "src/test/NewTest.txt"), "Write")).toBe("allow")
    expect(await decide(r, join(r.dir, "src/main/App.kt"))).toBe("allow")
    expect(await decide(r, "/tmp/elsewhere.txt", "Write")).toBe("allow")
  })

  test("the reason says why and what to do instead", async () => {
    const { r } = setup()
    const out = JSON.parse((await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, tool_name: "Edit", tool_input: { file_path: "scripts/build.sh" } }))).out)
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse")
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("scripts/build.sh is protected by the Gauntlet policy (config)")
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("report_blocked")
  })
})

describe("gauntlet connect", () => {
  test("claude-code writes once, reruns change nothing, and keeps the user's CLAUDE.md", async () => {
    const { r } = setup()
    writeFileSync(join(r.dir, "CLAUDE.md"), "# Project notes\n")
    const first = await cli(["connect", "claude-code", "--repo", r.dir])
    expect(first.code).toBe(0)
    const snapshot = () => [".claude/settings.json", ".mcp.json", "CLAUDE.md", "AGENTS.md"].map((p) => readFileSync(join(r.dir, p), "utf8"))
    const once = snapshot()
    await cli(["connect", "claude-code", "--repo", r.dir])
    expect(snapshot()).toEqual(once)
    expect(once[2]).toStartWith("# Project notes\n")
    expect(once[2]).toContain("report_blocked")
  })

  test("claude-code refuses to overwrite a settings file it can't read", async () => {
    const { r } = setup()
    r.write({ ".claude/settings.json": "{ oops" })
    const res = await cli(["connect", "claude-code", "--repo", r.dir])
    expect(res.code).not.toBe(0)
    expect(res.err).toContain(".claude/settings.json isn't a JSON object")
    expect(readFileSync(join(r.dir, ".claude/settings.json"), "utf8")).toBe("{ oops")
  })

  test("github --dry-run prints the workflow and writes nothing", async () => {
    const { r } = setup()
    const res = await cli(["connect", "github", "--repo", r.dir, "--dry-run"])
    expect(res.code).toBe(0)
    expect(res.out).toContain(".github/workflows/gauntlet.yml")
    expect(res.out).toContain("pull_request_target")
    expect(await Bun.file(join(r.dir, ".github/workflows/gauntlet.yml")).exists()).toBe(false)
  })
})
