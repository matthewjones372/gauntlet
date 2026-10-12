import { afterEach, describe, expect, test } from "bun:test"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo } from "./harness.ts"

// The agent often works under its owner's GitHub account, so GitHub can't
// tell an approval it posts from the owner's. Claude Code's hook refuses the
// agent's commands that would make an owner's decision (spec 0015).

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const bash = async (command: string) => {
  const { r } = baseRepo()
  repos.push(r)
  const res = await hookCli(["hook", "pre-tool-use"], JSON.stringify({ cwd: r.dir, tool_name: "Bash", tool_input: { command } }))
  return res.out === "" ? undefined : JSON.parse(res.out).hookSpecificOutput
}

describe("the hook and the owner's decisions", () => {
  test("refuses gauntlet approve, an approval comment and an approving review", async () => {
    for (const command of ["gauntlet approve 12 --override 'the budget test moved'", "gh pr comment 12 --body '/gauntlet approve 1234567'", "gh pr review 12 --approve"]) {
      const out = await bash(command)
      expect(out?.permissionDecision).toBe("deny")
      expect(out?.permissionDecisionReason).toContain("is the owner's decision")
      expect(out?.permissionDecisionReason).toContain("gauntlet approve")
    }
  })

  test("lets the agent check, request an override and open a pull request", async () => {
    expect(await bash("gauntlet check --working-tree")).toBeUndefined()
    expect(await bash("gauntlet override --reason 'the add test is broken on main' --approver @platform")).toBeUndefined()
    expect(await bash("gh pr create --title 'Stack 1/4' --body 'comment /gauntlet approve to accept'")).toBeUndefined()
  })
})
