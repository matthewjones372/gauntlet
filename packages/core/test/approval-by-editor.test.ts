import { describe, expect, test } from "bun:test"
import { commentApprovals, wordsOf } from "../src/github-status.ts"

// Anyone with write access can edit any comment on a pull request, Gauntlet's
// and an owner's included. A comment's text counts as from whoever last
// edited it, so an edit never forges an owner's approval: it only loses one.

const HEAD = "e2a8a60f3c9d4b1a0000000000000000deadbeef"
const owners = ["@owner"]
const BOT = "github-actions[bot]"
const RECORD = "<!-- gauntlet-report -->\n- [x] **Approve this change**: approved by owner (commit `e2a8a60f3c9d`)"
const TICKED = "<!-- gauntlet-report -->\n- [x] **Approve this change** (commit `e2a8a60f3c9d`)"
const approvals = (comments: Parameters<typeof commentApprovals>[0]) => commentApprovals(comments, HEAD, owners, {}).map((r) => r.user)

describe("approvals by whoever last edited the comment", () => {
  test("an owner's comment, and Gauntlet's record of an owner's tick, count", () => {
    expect(approvals([{ user: "owner", body: "/gauntlet approve e2a8a60f3c9d" }])).toEqual(["owner"])
    expect(approvals([{ user: BOT, editor: BOT, body: RECORD }])).toEqual(["owner"])
    expect(approvals([{ user: BOT, body: RECORD }])).toEqual(["owner"])
  })

  test("an owner ticking the box in Gauntlet's comment counts as the owner's", () => {
    expect(approvals([{ user: BOT, editor: "owner", body: TICKED }])).toEqual(["owner"])
  })

  test("someone else writing an approval record into Gauntlet's comment forges nothing", () => {
    expect(approvals([{ user: BOT, editor: "mallory", body: RECORD }])).toEqual([])
  })

  test("someone else editing an owner's old approval to name this commit forges nothing", () => {
    expect(approvals([{ user: "owner", editor: "mallory", body: "/gauntlet approve e2a8a60f3c9d" }])).toEqual([])
  })

  test("someone else ticking the box counts as theirs, and they aren't an owner", () => {
    expect(approvals([{ user: BOT, editor: "mallory", body: TICKED }])).toEqual([])
  })

  test("a comment's words are its last editor's, else its author's", () => {
    expect(wordsOf({ user: "a", body: "" })).toBe("a")
    expect(wordsOf({ user: "a", editor: "b", body: "" })).toBe("b")
  })
})
