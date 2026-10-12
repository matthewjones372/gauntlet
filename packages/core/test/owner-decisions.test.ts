import { describe, expect, test } from "bun:test"
import { ownerDecision } from "../src/index.ts"

// Approving is the owner's decision (spec 0015). Claude Code's hook asks this
// whether a shell command would make one, and refuses it to the agent.

describe("ownerDecision", () => {
  test("gauntlet approve, however it's started", () => {
    expect(ownerDecision("gauntlet approve 12")).toBe("gauntlet approve")
    expect(ownerDecision("gauntlet approve 12 --override 'the budget test moved'")).toBe("gauntlet approve")
    expect(ownerDecision("cd repo && ./dist/gauntlet approve 12 --head abc1234")).toBe("gauntlet approve")
    expect(ownerDecision("bunx gauntlet   approve 3")).toBe("gauntlet approve")
    expect(ownerDecision("bash -c 'gauntlet approve 12'")).toBe("gauntlet approve")
    expect(ownerDecision("bun packages/cli/src/main.ts approve 12")).toBe("gauntlet approve")
  })

  test("an approval comment or an approving review through gh", () => {
    expect(ownerDecision("gh pr comment 12 --body '/gauntlet approve 1234567'")).toBe("an approval comment")
    expect(ownerDecision(`gh api repos/o/r/issues/12/comments -f body="/gauntlet approve abcdef0"`)).toBe("an approval comment")
    expect(ownerDecision("gh pr review 12 --approve")).toBe("an approving review")
    expect(ownerDecision("gh pr review 12 -a -b ok")).toBe("an approving review")
    expect(ownerDecision("gh api -X POST repos/o/r/pulls/12/reviews -f event=APPROVE")).toBe("an approving review")
  })

  test("everything else is the agent's to run", () => {
    expect(ownerDecision("gauntlet check --working-tree")).toBeUndefined()
    expect(ownerDecision("gauntlet override --reason 'needs an owner' --approver @o")).toBeUndefined()
    expect(ownerDecision("git commit -m 'gauntlet approve: one command per decision'")).toBeUndefined()
    expect(ownerDecision("echo '/gauntlet approve 1234567' > notes.md")).toBeUndefined()
    expect(ownerDecision("gh pr review 12 --request-changes -b 'fix it'")).toBeUndefined()
    expect(ownerDecision("gh pr create --title 'Stack 1/4: gauntlet approve'")).toBeUndefined()
    // A pull request's description may tell the owner what to comment.
    expect(ownerDecision("gh pr create --body 'Then comment /gauntlet approve 1234567'")).toBeUndefined()
    expect(ownerDecision("grep -rn approve packages")).toBeUndefined()
  })
})
