import { describe, expect, test } from "bun:test"
import { approvalsOn, githubStatus, type OverrideRecord, type Report } from "../src/index.ts"

const HEAD = "h".repeat(40)
const report = (over: { tier?: Report["decision"]["tier"]; blocking?: boolean; wouldBlock?: boolean; mode?: "shadow" | "enforce"; owners?: string[]; policyOwners?: string[] } = {}): Report => ({
  policy: { irHash: "ir", headSha: HEAD, owners: over.policyOwners ?? ["@platform"] },
  decision: {
    tier: over.tier ?? "auto", mode: over.mode ?? "enforce", blocking: over.blocking ?? false, wouldBlock: over.wouldBlock ?? over.blocking ?? false,
    owners: over.owners ?? [], nominations: [{ tier: "review", reason: "unit failed", blocking: true, rule: "gate-failed" }], overrides: [],
  },
}) as unknown as Report

const approve = (user: string, commitId = HEAD) => ({ user, state: "APPROVED", commitId })
const override = (approver: string): OverrideRecord => ({ headSha: HEAD, irHash: "ir", reason: "hotfix for an outage", approver, requestedBy: "dev@x" })

describe("githubStatus", () => {
  test("auto and skim succeed; review needs an approval on this commit", () => {
    expect(githubStatus(report(), [], {}, []).conclusion).toBe("success")
    expect(githubStatus(report({ tier: "review" }), [], {}, []).conclusion).toBe("action_required")
    expect(githubStatus(report({ tier: "review" }), [approve("alice", "old")], {}, []).conclusion).toBe("action_required")
    expect(githubStatus(report({ tier: "review" }), [approve("alice")], {}, []).conclusion).toBe("success")
  })

  test("owner tier needs an owner, directly or through a team", () => {
    const r = report({ tier: "owner", owners: ["@payments-lead", "@acme/payments"] })
    expect(githubStatus(r, [approve("alice")], {}, []).conclusion).toBe("action_required")
    expect(githubStatus(r, [approve("payments-lead")], {}, []).conclusion).toBe("success")
    expect(githubStatus(r, [approve("bob")], { "@acme/payments": ["bob"] }, []).conclusion).toBe("success")
    expect(githubStatus(r, [approve("platform")], {}, []).conclusion).toBe("success")
  })

  test("a later review supersedes an earlier approval", () => {
    expect(approvalsOn([approve("alice"), { user: "alice", state: "CHANGES_REQUESTED", commitId: HEAD }], HEAD)).toEqual([])
    expect(approvalsOn([approve("alice"), { user: "alice", state: "COMMENTED", commitId: HEAD }], HEAD)).toEqual(["alice"])
  })

  test("blocking fails unless an owner's override is approved on this commit", () => {
    const r = report({ tier: "review", blocking: true })
    expect(githubStatus(r, [], {}, []).conclusion).toBe("failure")
    expect(githubStatus(r, [], {}, [override("@platform")]).conclusion).toBe("failure")
    expect(githubStatus(r, [approve("mallory")], {}, [override("@mallory")]).conclusion).toBe("failure")
    expect(githubStatus(r, [approve("platform", "old")], {}, [override("@platform")]).conclusion).toBe("failure")
    const ok = githubStatus(r, [approve("platform")], {}, [override("@platform")])
    expect(ok.conclusion).toBe("success")
    expect(ok.honouredOverrides).toHaveLength(1)
  })

  test("an override for another policy or commit doesn't count", () => {
    const r = report({ tier: "review", blocking: true })
    expect(githubStatus(r, [approve("platform")], {}, [{ ...override("@platform"), irHash: "other" }]).conclusion).toBe("failure")
    expect(githubStatus(r, [approve("platform")], {}, [{ ...override("@platform"), headSha: "x" }]).conclusion).toBe("failure")
  })

  test("shadow mode never fails", () => {
    expect(githubStatus(report({ tier: "review", wouldBlock: true, mode: "shadow" }), [], {}, []).conclusion).toBe("neutral")
  })
})
