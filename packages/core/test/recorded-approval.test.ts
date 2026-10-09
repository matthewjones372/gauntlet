import { describe, expect, test } from "bun:test"
import { commentApprovals } from "../src/github-status.ts"

// An approval Gauntlet recorded in its own report comment counts for the
// commit it names, from the workflow's comment only.

const HEAD = "e2a8a60f3c9d4b1a7e6f5d4c3b2a1908f7e6d5c4"
const recorded = (sha: string) => ({ user: "github-actions[bot]", body: `<!-- gauntlet-report -->\n- [x] **Approve this change**: approved by payments, mallory (commit \`${sha}\`)` })

describe("approvals recorded in Gauntlet's comment", () => {
  test("count for their commit, and only for owners named in them", () => {
    expect(commentApprovals([recorded("e2a8a60f3c9d")], HEAD, ["@payments"], {})).toEqual([{ user: "payments", state: "APPROVED", commitId: HEAD }])
  })

  test("an approval recorded for another commit doesn't count", () => {
    expect(commentApprovals([recorded("1234567890ab")], HEAD, ["@payments"], {})).toEqual([])
  })
})
