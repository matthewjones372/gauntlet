import { describe, expect, test } from "bun:test"
import { githubStatus, type OverrideRecord, type Report } from "../src/index.ts"

// An override recorded against a policy other than the one the change is
// judged with doesn't count; the check says so instead of just staying blocked.

const HEAD = "h".repeat(40)
const report = (): Report => ({
  policy: { irHash: "judged-ir-hash", headSha: HEAD, owners: ["@platform"] },
  decision: {
    tier: "review", mode: "enforce", blocking: true, wouldBlock: true,
    owners: [], nominations: [{ tier: "review", reason: "unit failed", blocking: true, rule: "gate-failed" }], overrides: [],
  },
}) as unknown as Report
const approved = [{ user: "platform", state: "APPROVED", commitId: HEAD }]
const override = (irHash: string): OverrideRecord => ({ headSha: HEAD, irHash, reason: "hotfix for an outage", approver: "@platform", requestedBy: "dev@x" })

describe("an override recorded against another policy", () => {
  test("isn't honoured, and the check names both policies and the command that records it right", () => {
    const s = githubStatus(report(), approved, {}, [override("other-ir-hash")])
    expect(s.conclusion).toBe("failure")
    expect(s.summary).toContain("doesn't count: it was recorded against policy IR other-ir-has")
    expect(s.summary).toContain("judged with its base's policy (IR judged-ir-ha)")
    expect(s.summary).toContain(`gauntlet approve <pr> --override "<reason>" --head ${HEAD.slice(0, 12)}`)
  })

  test("names the commit it was recorded against, when the note says", () => {
    const s = githubStatus(report(), approved, {}, [{ ...override("other-ir-hash"), policySha: "c".repeat(40) }])
    expect(s.summary).toContain(`recorded against the policy at ${"c".repeat(12)} (IR other-ir-has)`)
  })

  test("a matching one is honoured and the explanation isn't shown", () => {
    const s = githubStatus(report(), approved, {}, [override("judged-ir-hash")])
    expect(s.conclusion).toBe("success")
    expect(s.summary).not.toContain("recorded against")
  })

  test("an override for another commit says nothing about policies", () => {
    const s = githubStatus(report(), approved, {}, [{ ...override("other-ir-hash"), headSha: "x".repeat(40) }])
    expect(s.conclusion).toBe("failure")
    expect(s.summary).not.toContain("recorded against")
  })
})
