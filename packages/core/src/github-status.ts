import { Schema } from "effect"
import type { OverrideRecord } from "./overrides.ts"
import type { Report } from "./report/schema.ts"

// The `gauntlet` check on a pull request (ADR 0015 layer d), from the trusted
// report, the PR's reviews and the overrides recorded for its head commit.
// Gauntlet never merges or approves; this only says whether the tier's
// requirement is met.

export const Review = Schema.Struct({
  user: Schema.String,
  state: Schema.String,
  commitId: Schema.String,
})
export type Review = typeof Review.Type

/** Members of the teams that appear as owners, resolved by the workflow (`@org/team` -> logins). */
export const Teams = Schema.Record(Schema.String, Schema.Array(Schema.String))
export type Teams = typeof Teams.Type

export interface GithubStatus {
  readonly conclusion: "success" | "failure" | "action_required" | "neutral"
  readonly title: string
  readonly summary: string
  readonly approvedBy: ReadonlyArray<string>
  readonly honouredOverrides: ReadonlyArray<OverrideRecord>
}

/** Logins whose latest review approves exactly this commit. A later push needs a new approval. */
export const approvalsOn = (reviews: ReadonlyArray<Review>, head: string): string[] => {
  const latest = new Map<string, Review>()
  for (const r of reviews) if (r.state !== "COMMENTED") latest.set(r.user.toLowerCase(), r)
  return [...latest.values()].filter((r) => r.state === "APPROVED" && r.commitId === head).map((r) => r.user).sort()
}

/** Whether a login counts as one of the owners (`@user` or a member of `@org/team`). */
const isOwner = (login: string, owners: ReadonlyArray<string>, teams: Teams) =>
  owners.some((o) => {
    const name = o.replace(/^@/, "").toLowerCase()
    return name.includes("/") ? (teams[o] ?? []).some((m) => m.toLowerCase() === login.toLowerCase()) : name === login.toLowerCase()
  })

export const githubStatus = (report: Report, reviews: ReadonlyArray<Review>, teams: Teams, overrides: ReadonlyArray<OverrideRecord>): GithubStatus => {
  const head = report.policy.headSha
  const approvers = approvalsOn(reviews, head)
  const d = report.decision
  // Owners who can approve an owner tier: those the decision names, and the policy owners.
  const tierOwners = [...new Set([...d.owners, ...report.policy.owners])]
  // An override counts only if its approver approved this exact commit and owns the policy or a touched zone.
  const honoured = overrides.filter((o) =>
    o.headSha === head && o.irHash === report.policy.irHash && tierOwners.includes(o.approver) && approvers.some((a) => isOwner(a, [o.approver], teams)))

  if (d.blocking && honoured.length === 0) {
    const first = d.nominations.find((n) => n.blocking)
    return { conclusion: "failure", title: `Blocked (${d.tier})`, summary: first ? first.reason : "A gate failed.", approvedBy: approvers, honouredOverrides: [] }
  }
  if (d.mode === "shadow" && d.wouldBlock) {
    return { conclusion: "neutral", title: `Would block in enforce mode (${d.tier})`, summary: "Shadow mode: Gauntlet reports but never blocks.", approvedBy: approvers, honouredOverrides: [] }
  }
  const overridden = honoured.length > 0 ? ` Overridden by ${honoured.map((o) => o.approver).join(", ")}: ${honoured[0]!.reason}` : ""
  switch (d.tier) {
    case "auto":
    case "skim":
      return { conclusion: "success", title: d.tier === "auto" ? "Auto: no review needed" : "Skim", summary: `Tier ${d.tier}.${overridden}`, approvedBy: approvers, honouredOverrides: honoured }
    case "review":
      return approvers.length > 0
        ? { conclusion: "success", title: "Reviewed", summary: `Tier review, approved by ${approvers.join(", ")}.${overridden}`, approvedBy: approvers, honouredOverrides: honoured }
        : { conclusion: "action_required", title: "Needs review", summary: "Tier review: an approving review on this commit is required.", approvedBy: approvers, honouredOverrides: honoured }
    case "owner": {
      const owning = approvers.filter((a) => isOwner(a, tierOwners, teams))
      return owning.length > 0
        ? { conclusion: "success", title: "Approved by an owner", summary: `Tier owner, approved by ${owning.join(", ")}.${overridden}`, approvedBy: approvers, honouredOverrides: honoured }
        : {
          conclusion: "action_required",
          title: "Needs an owner",
          summary: `Tier owner: an approving review on this commit from ${tierOwners.length > 0 ? tierOwners.join(", ") : "an owner (the policy names none; add `owners` to .gauntlet/policy.gx)"} is required.`,
          approvedBy: approvers,
          honouredOverrides: honoured,
        }
    }
  }
}
