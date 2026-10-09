import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { hookCli } from "./agent-harness.ts"
import { cli } from "./harness.ts"

// The point of Gauntlet: a change reaches the default branch only through a
// pull request, where the checks run. Setup works on a branch of its own, and
// Claude Code's hook refuses a push to the default branch.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const project = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({ "go.mod": "module example.com/svc\n\ngo 1.21\n", "a.go": "package svc\n\nfunc A() int { return 1 }\n", "a_test.go": "package svc\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif A() != 1 {\n\t\tt.Fatal(\"no\")\n\t}\n}\n" })
  r.commit("existing project")
  return r
}

describe("setup never lands on the default branch", () => {
  test("apply on main commits to gauntlet/setup, leaves main as it was, and says to open a pull request", async () => {
    const r = project()
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    const res = await cli(["apply", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(r.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("gauntlet/setup")
    expect(r.git("log", "--format=%s", "main")).toBe("existing project")
    expect(r.git("log", "--format=%s", "gauntlet/setup").split("\n")).toContain("Record Gauntlet baseline")
    expect(res.out).toContain("Setup commits to the branch gauntlet/setup")
    expect(res.out).toContain("git push -u origin gauntlet/setup")
  }, 120_000)
})

describe("Claude Code's hook and git push", () => {
  const decide = async (r: TempRepo, command: string) => {
    const out = (await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, tool_name: "Bash", tool_input: { command } }))).out
    return out === "" ? { decision: "allow", reason: "" } : { decision: JSON.parse(out).hookSpecificOutput.permissionDecision, reason: JSON.parse(out).hookSpecificOutput.permissionDecisionReason }
  }

  test("a push to the default branch is refused, with what to do instead", async () => {
    const r = project()
    const res = await decide(r, "git push origin main")
    expect(res.decision).toBe("deny")
    expect(res.reason).toContain("Changes reach main only through a pull request")
    expect((await decide(r, "git push")).decision).toBe("deny")
  })

  test("a push from a branch, and every other command, is allowed", async () => {
    const r = project()
    r.git("switch", "-q", "-c", "feature")
    expect((await decide(r, "git push -u origin feature")).decision).toBe("allow")
    expect((await decide(r, "bun test")).decision).toBe("allow")
  })
})
