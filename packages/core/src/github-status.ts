import { Schema } from "effect"
import type { OverrideRecord } from "./overrides.ts"
import { verdictLines } from "./report/render.ts"
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

/** A pull request comment, for owner approvals by comment. */
export const PrComment = Schema.Struct({ user: Schema.String, body: Schema.String })
export type PrComment = typeof PrComment.Type

const APPROVE = /^\/gauntlet approve ([0-9a-f]{7,40})$/i

/**
 * Owners' \`/gauntlet approve <commit>\` comments, as approvals of that commit.
 * GitHub never lets an author approve their own pull request, and an agent
 * opens them under its owner's account, so on a repository with one owner a
 * review could never be given. The comment names the commit, so it counts
 * only for that commit, like a review; anyone but an owner is ignored.
 */
export const commentApprovals = (comments: ReadonlyArray<PrComment>, head: string, owners: ReadonlyArray<string>, teams: Teams): Review[] =>
  comments.flatMap((c) => {
    const sha = APPROVE.exec(c.body.trim())?.[1]?.toLowerCase()
    return sha !== undefined && head.toLowerCase().startsWith(sha) && isOwner(c.user, owners, teams) ? [{ user: c.user, state: "APPROVED", commitId: head }] : []
  })

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

/**
 * The check run for a report. Its summary always starts with two lines, the
 * integrity verdict and then the gate results, so a passing check can't hide
 * a weakened test behind one green badge (spec 0001).
 */
export const githubStatus = (report: Report, reviews: ReadonlyArray<Review>, teams: Teams, overrides: ReadonlyArray<OverrideRecord>, comments: ReadonlyArray<PrComment> = []): GithubStatus => {
  const owners = [...new Set([...report.decision.owners, ...report.policy.owners])]
  const all = [...reviews, ...commentApprovals(comments, report.policy.headSha, owners, teams)]
  const s = report.decision.scope === "protect-only" ? protectOnlyStatus(report, all) : tierStatus(report, all, teams, overrides)
  return { ...s, summary: [...verdictLines(report), "", s.summary].join("\n") }
}

/** Protect-only is pass or fail; approvals don't change it. */
const protectOnlyStatus = (report: Report, reviews: ReadonlyArray<Review>): GithubStatus => {
  const approvers = approvalsOn(reviews, report.policy.headSha)
  const first = report.decision.nominations.find((n) => n.blocking)
  return report.decision.blocking
    ? { conclusion: "failure", title: "Protect-only: failed", summary: first ? first.reason : "A check failed.", approvedBy: approvers, honouredOverrides: [] }
    : { conclusion: "success", title: "Protect-only: passed", summary: "The verification boundary held. Review the change as usual.", approvedBy: approvers, honouredOverrides: [] }
}

/** How a reviewer decides, in the check's summary: the approval GitHub already has, spelled out. */
const howToDecide = (who: string, head: string, owners: ReadonlyArray<string>): string =>
  [
    "",
    "How to decide:",
    `- Accept: ${who} opens Files changed, then Review changes, and chooses Approve. This check turns green for this commit.`,
    `- If you opened this pull request yourself, GitHub won't let you approve it: ${owners.length > 0 ? `as an owner (${owners.join(", ")})` : "as an owner"}, comment \`/gauntlet approve ${head.slice(0, 12)}\` instead.`,
    "- Reject: choose Request changes and say what needs to change. The check stays as it is until a new commit is approved.",
    "An approval counts only for the commit it was given on: a new push needs a new approval.",
  ].join("\n")

/** What to do when a change is blocked: fix it, or an owner overrides it, recorded and approved. */
const howToUnblock = (owners: ReadonlyArray<string>): string =>
  [
    "",
    "What to do:",
    "- Fix it: push a commit that makes the failing check pass. This check runs again.",
    `- If it must merge anyway: run \`gauntlet override --reason "..." --approver ${owners[0] ?? "@owner"}\` and push the note (\`git push origin refs/notes/gauntlet-overrides\`). It takes effect when that owner approves this commit.`,
  ].join("\n")

const tierStatus = (report: Report, reviews: ReadonlyArray<Review>, teams: Teams, overrides: ReadonlyArray<OverrideRecord>): GithubStatus => {
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
    return { conclusion: "failure", title: `Blocked (${d.tier})`, summary: `${first ? first.reason : "A gate failed."}${howToUnblock(tierOwners)}`, approvedBy: approvers, honouredOverrides: [] }
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
        : { conclusion: "action_required", title: "Needs review", summary: `Tier review: an approving review on this commit is required.${howToDecide("a reviewer", head, tierOwners)}`, approvedBy: approvers, honouredOverrides: honoured }
    case "owner": {
      const owning = approvers.filter((a) => isOwner(a, tierOwners, teams))
      return owning.length > 0
        ? { conclusion: "success", title: "Approved by an owner", summary: `Tier owner, approved by ${owning.join(", ")}.${overridden}`, approvedBy: approvers, honouredOverrides: honoured }
        : {
          conclusion: "action_required",
          title: "Needs an owner",
          summary: `Tier owner: an approving review on this commit from ${tierOwners.length > 0 ? tierOwners.join(", ") : "an owner (the policy names none; add `owners` to .gauntlet/policy.gx)"} is required.${howToDecide(tierOwners.length > 0 ? tierOwners.join(" or ") : "an owner", head, tierOwners)}`,
          approvedBy: approvers,
          honouredOverrides: honoured,
        }
    }
  }
}
