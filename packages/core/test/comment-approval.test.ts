import { describe, expect, test } from "bun:test"
import { commentApprovals } from "../src/github-status.ts"

// GitHub never lets an author approve their own pull request, so an owner
// approves with `/gauntlet approve <commit>`: for that commit only, owners only.

const HEAD = "e2a8a60f3c9d4b1a7e6f5d4c3b2a1908f7e6d5c4"
const owners = ["@matthewjones372", "@org/platform"]
const teams = { "@org/platform": ["alice"] }

describe("owner approval by comment", () => {
  test("an owner's comment naming this commit approves it", () => {
    expect(commentApprovals([{ user: "MatthewJones372", body: "/gauntlet approve e2a8a60f3c9d" }], HEAD, owners, teams)).toEqual([{ user: "MatthewJones372", state: "APPROVED", commitId: HEAD }])
    expect(commentApprovals([{ user: "alice", body: "  /gauntlet approve E2A8A60\n" }], HEAD, owners, teams)).toHaveLength(1)
  })

  test("another commit, a non-owner, a short sha or extra words don't count", () => {
    const none = (user: string, body: string) => expect(commentApprovals([{ user, body }], HEAD, owners, teams)).toEqual([])
    none("matthewjones372", "/gauntlet approve 1234567")
    none("mallory", "/gauntlet approve e2a8a60")
    none("matthewjones372", "/gauntlet approve e2a8a6")
    none("matthewjones372", "looks fine /gauntlet approve e2a8a60")
  })
})
