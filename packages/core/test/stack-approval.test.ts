import { describe, expect, test } from "bun:test"
import { agentSummary, renderAgentSummary } from "../src/report/agent.ts"
import { stackApprovals } from "../src/github-status.ts"

// In a stack, an owner's tick on a pull request higher up approves this one
// too, but only when that pull request's commit contains this one: a pull
// request pointed at this branch without its commits approves nothing here.

const HEAD = "bbbbbbbbbbbb0000000000000000000000000000"
const TOP = "cccccccccccc0000000000000000000000000000"
const owners = ["@owner"]
const ticked = (sha: string, editor: string) => ({ user: "github-actions[bot]", editor, body: `<!-- gauntlet-report -->\n- [x] **Approve this change** (commit \`${sha.slice(0, 12)}\`)` })

describe("approving a stack from the top", () => {
  test("an owner's tick on a pull request above that contains this one approves it", () => {
    expect(stackApprovals({ below: [], above: [{ number: 72, head: TOP, contains: true, comments: [ticked(TOP, "owner")] }] }, HEAD, owners, {}))
      .toEqual([{ user: "owner", state: "APPROVED", commitId: HEAD }])
  })

  test("one that doesn't contain it approves nothing here", () => {
    expect(stackApprovals({ below: [], above: [{ number: 80, head: TOP, contains: false, comments: [ticked(TOP, "owner")] }] }, HEAD, owners, {})).toEqual([])
  })

  test("a tick by someone who isn't an owner, or for another commit, approves nothing", () => {
    expect(stackApprovals({ below: [], above: [{ number: 72, head: TOP, contains: true, comments: [ticked(TOP, "mallory")] }] }, HEAD, owners, {})).toEqual([])
    expect(stackApprovals({ below: [], above: [{ number: 72, head: TOP, contains: true, comments: [ticked("dddddddddddd0000", "owner")] }] }, HEAD, owners, {})).toEqual([])
  })

  test("no stack, no approvals from it", () => {
    expect(stackApprovals(undefined, HEAD, owners, {})).toEqual([])
  })

  test("the agent splitting a change checks every branch with Gauntlet and says how a stack is approved and merged", () => {
    const report = {
      decision: { tier: "auto", wouldBlock: false, nominations: [] },
      checks: [], remediation: [], facts: { zonesTouched: [] }, policy: { headSha: "abc", notes: [] },
      stack: { lines: 500, steps: [{ title: "packages/core", files: ["a.ts"], lines: 300, needsOwner: false }, { title: "packages/cli", files: ["b.ts"], lines: 200, needsOwner: false }] },
    } as never
    const text = renderAgentSummary(agentSummary(report, "out"))
    expect(text).toContain("run Gauntlet's check on every branch, not only the tests")
    expect(text).toContain("ticking the box on the top pull request approves the whole stack")
    expect(text).toContain("`gh pr merge --merge`")
  })
})
