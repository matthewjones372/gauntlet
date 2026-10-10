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

/**
 * A pull request comment, for owner approvals by comment: who wrote it, who
 * last edited it if anyone did, and its text now.
 */
export const PrComment = Schema.Struct({ user: Schema.String, editor: Schema.optionalKey(Schema.String), body: Schema.String })
export type PrComment = typeof PrComment.Type

/**
 * Whose words a comment's text is: whoever last edited it, else its author.
 * Anyone with write access can edit any comment, Gauntlet's and an owner's
 * included, so a comment's author alone says nothing about its text.
 */
export const wordsOf = (c: PrComment): string => c.editor ?? c.user

const APPROVE = /^\/gauntlet approve ([0-9a-f]{7,40})$/i
/** The ticked box in Gauntlet's report, as the person who ticked it sends it. */
const TICKED = /^- \[x\] \*\*Approve this change\*\* \(commit `([0-9a-f]{7,40})`\)$/im
/** An approval Gauntlet recorded in its own report comment, which only its workflow writes. */
const RECORDED = /^- \[x\] \*\*Approve this change\*\*: approved by ([^(]+) \(commit `([0-9a-f]{7,40})`\)$/im
const WORKFLOW = "github-actions[bot]"

/**
 * Owners' \`/gauntlet approve <commit>\` comments, and the box in Gauntlet's
 * report ticked by an owner (the workflow passes it as from whoever ticked
 * it), as approvals of that commit. A comment's text counts as from whoever
 * last edited it (`wordsOf`), so editing an owner's comment or Gauntlet's own
 * record of an approval never forges one: the approval just goes.
 * GitHub never lets an author approve their own pull request, and an agent
 * opens them under its owner's account, so on a repository with one owner a
 * review could never be given. The comment names the commit, so it counts
 * only for that commit, like a review; anyone but an owner is ignored.
 */
export const commentApprovals = (comments: ReadonlyArray<PrComment>, head: string, owners: ReadonlyArray<string>, teams: Teams): Review[] =>
  comments.flatMap((c) => {
    // A box ticked earlier, as Gauntlet's own comment records it: still the owners' approval of that commit,
    // as long as nobody but Gauntlet's workflow edited the comment since.
    const who = wordsOf(c)
    const recorded = who === WORKFLOW ? RECORDED.exec(c.body) : null
    if (recorded) {
      return head.toLowerCase().startsWith(recorded[2]!.toLowerCase())
        ? recorded[1]!.split(",").map((u) => u.trim()).filter((u) => isOwner(u, owners, teams)).map((user) => ({ user, state: "APPROVED", commitId: head }))
        : []
    }
    const sha = (APPROVE.exec(c.body.trim())?.[1] ?? TICKED.exec(c.body)?.[1])?.toLowerCase()
    return sha !== undefined && head.toLowerCase().startsWith(sha) && isOwner(who, owners, teams) ? [{ user: who, state: "APPROVED", commitId: head }] : []
  })

/** Who ticked the box or commented an approval of this commit without being an owner. */
export const nonOwnerApprovals = (comments: ReadonlyArray<PrComment>, head: string, owners: ReadonlyArray<string>, teams: Teams): string[] =>
  [...new Set(comments.flatMap((c) => {
    const sha = (APPROVE.exec(c.body.trim())?.[1] ?? TICKED.exec(c.body)?.[1])?.toLowerCase()
    const who = wordsOf(c)
    return sha !== undefined && head.toLowerCase().startsWith(sha) && who !== WORKFLOW && !isOwner(who, owners, teams) ? [who] : []
  }))].sort()

/** Members of the teams that appear as owners, resolved by the workflow (`@org/team` -> logins). */
export const Teams = Schema.Record(Schema.String, Schema.Array(Schema.String))
export type Teams = typeof Teams.Type

export interface GithubStatus {
  readonly conclusion: "success" | "failure" | "action_required" | "neutral"
  readonly title: string
  readonly summary: string
  readonly approvedBy: ReadonlyArray<string>
  readonly honouredOverrides: ReadonlyArray<OverrideRecord>
  /** People who ticked the box or commented an approval of this commit but aren't owners: ignored, and said so. */
  readonly notOwners?: ReadonlyArray<string>
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
  // A tick from someone who isn't an owner is ignored, and the check says so: the owner ticks the box themselves.
  const notOwners = s.conclusion === "success" ? [] : nonOwnerApprovals(comments, report.policy.headSha, owners, teams)
  const ignored = notOwners.length > 0
    ? [`${notOwners.map((u) => `@${u}`).join(", ")} ticked the box or approved, but only ${owners.length > 0 ? `an owner (${owners.join(", ")})` : "an owner"} can approve, so it doesn't count. The box is unticked again: an owner ticks it.`, ""]
    : []
  return { ...s, summary: [...verdictLines(report), "", ...ignored, s.summary].join("\n"), ...(notOwners.length > 0 ? { notOwners } : {}) }
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
  // The zones a change touches, in the check's title, so a list of pull requests shows where to look.
  // A report from an older evidence job may carry no facts.
  const zones = (report.facts?.zonesTouched ?? []).map((z) => z.zone)
  const where = zones.length > 0 ? `: touches ${zones.join(", ")}` : ""
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
        ? { conclusion: "success", title: `Approved by ${approvers.join(", ")}`, summary: `Tier review, approved by ${approvers.join(", ")} for commit ${head.slice(0, 12)}.${overridden}`, approvedBy: approvers, honouredOverrides: honoured }
        : { conclusion: "action_required", title: `Needs review${where}`, summary: `Tier review: an approving review on this commit is required.${howToDecide("a reviewer", head, tierOwners)}`, approvedBy: approvers, honouredOverrides: honoured }
    case "owner": {
      const owning = approvers.filter((a) => isOwner(a, tierOwners, teams))
      return owning.length > 0
        ? { conclusion: "success", title: `Approved by ${owning.join(", ")} (owner)`, summary: `Tier owner, approved by ${owning.join(", ")} for commit ${head.slice(0, 12)}.${overridden}`, approvedBy: approvers, honouredOverrides: honoured }
        : {
          conclusion: "action_required",
          title: `Needs an owner${where}`,
          summary: `Tier owner: an approving review on this commit from ${tierOwners.length > 0 ? tierOwners.join(", ") : "an owner (the policy names none; add `owners` to .gauntlet/policy.gx)"} is required.${howToDecide(tierOwners.length > 0 ? tierOwners.join(" or ") : "an owner", head, tierOwners)}`,
          approvedBy: approvers,
          honouredOverrides: honoured,
        }
    }
  }
}
