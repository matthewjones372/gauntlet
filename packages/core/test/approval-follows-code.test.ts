import { describe, expect, test } from "bun:test"
import { commentApprovals } from "../src/github-status.ts"

// Approvals follow the code, not the commit (spec 0015). Gauntlet records an
// approval with the approved commit's tree and the tree of the base it was
// judged against; a new commit with the same tree and the same judged base has
// the same diff, so the approval carries over. Any change to either voids it.

const OLD = "1111111111111111111111111111111111111111"
const NEW = "2222222222222222222222222222222222222222"
const TREE = "a".repeat(40)
const BASE = "b".repeat(40)
const BOT = "github-actions[bot]"
const record = (sha: string, code?: { tree: string; base: string }) =>
  `<!-- gauntlet-report -->\n- [x] **Approve this change**: approved by payments (commit \`${sha.slice(0, 12)}\`)${code ? ` <!-- tree ${code.tree} base ${code.base} -->` : ""}`

describe("an approval recorded with its code", () => {
  test("carries to a new commit with the same tree and judged base", () => {
    expect(commentApprovals([{ user: BOT, body: record(OLD, { tree: TREE, base: BASE }) }], NEW, ["@payments"], {}, { tree: TREE, base: BASE }))
      .toEqual([{ user: "payments", state: "APPROVED", commitId: NEW }])
  })

  test("still counts for its own commit", () => {
    expect(commentApprovals([{ user: BOT, body: record(OLD, { tree: TREE, base: BASE }) }], OLD, ["@payments"], {}, { tree: "c".repeat(40), base: BASE }))
      .toEqual([{ user: "payments", state: "APPROVED", commitId: OLD }])
  })

  test("is void when the tree or the base differs: the diff changed", () => {
    expect(commentApprovals([{ user: BOT, body: record(OLD, { tree: TREE, base: BASE }) }], NEW, ["@payments"], {}, { tree: "c".repeat(40), base: BASE })).toEqual([])
    expect(commentApprovals([{ user: BOT, body: record(OLD, { tree: TREE, base: BASE }) }], NEW, ["@payments"], {}, { tree: TREE, base: "c".repeat(40) })).toEqual([])
  })

  test("an old record without its code counts only for its commit", () => {
    expect(commentApprovals([{ user: BOT, body: record(OLD) }], NEW, ["@payments"], {}, { tree: TREE, base: BASE })).toEqual([])
  })

  test("a record anyone else edited counts for nothing", () => {
    expect(commentApprovals([{ user: BOT, editor: "mallory", body: record(OLD, { tree: TREE, base: BASE }) }], NEW, ["@payments"], {}, { tree: TREE, base: BASE })).toEqual([])
  })

  test("an owner's comment names a commit, never code: it doesn't carry", () => {
    expect(commentApprovals([{ user: "payments", body: `/gauntlet approve ${OLD.slice(0, 12)}` }], NEW, ["@payments"], {}, { tree: TREE, base: BASE })).toEqual([])
  })
})
