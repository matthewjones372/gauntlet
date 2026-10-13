import { sha256 } from "@gauntlet/ir"
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import { blockingSet } from "./blocked.ts"
import { Git } from "./git.ts"
import { ProcessRunner } from "./process-runner.ts"
import type { Report } from "./report/schema.ts"

// A bounded exit for the agent hooks (ADR 0026, spec 0018). Each stop the
// check blocks is an attempt, counted per branch. After too many blocks on the
// same findings, or too many on the branch, the agent may stop as
// "exhausted": an explicit outcome that is never a pass. Nothing but the
// hooks reads this state; `check`, the GitHub job and the review decision
// judge the change as they always did.
//
// The state lives in the git common directory, out of every worktree, with a
// witness ref naming the blob of the file's exact bytes. Anything but both
// present and matching, or both absent, counts as already at the limits:
// deleting or corrupting it can bring the exhaustion forward, never put it off.

export const ATTEMPT_STATUSES = ["blocked", "exhausted", "reported-blocked"] as const
export const ATTEMPT_STATES = ["ok", "missing", "corrupt"] as const

const Counts = Schema.Struct({ unchanged: Schema.Number, total: Schema.Number })

export const AttemptRecord = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(ATTEMPT_STATUSES),
  branch: Schema.String,
  attempts: Counts,
  limits: Counts,
  fingerprint: Schema.String,
  /** The fingerprint's lines: gate, finding kind, check, file, rule. */
  findings: Schema.Array(Schema.String),
  /** The blocking findings as the report words them. */
  reasons: Schema.Array(Schema.String),
  /** What the stored record was when this attempt read it: a missing or corrupt one counts as at the limits. */
  state: Schema.Literals(ATTEMPT_STATES),
  /** The agent's `report_blocked` reason, while it still matches. */
  reportedReason: Schema.optionalKey(Schema.String),
})
export type AttemptRecord = typeof AttemptRecord.Type
export type AttemptLimits = typeof Counts.Type

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(AttemptRecord))

/** The test id at the start of a failure line ("<id>: <message>"), without the message, which can drift. */
const testId = (failure: string) => {
  const at = failure.indexOf(": ")
  return at > 0 ? failure.slice(0, at) : failure
}

/**
 * What a block is about, in lines that stay the same from run to run: the
 * gate and its failing tests, each finding's kind, check, rule and file, and
 * the rules of the blocking nominations. Never a message, a count or a line
 * number, so an edit that moves a finding doesn't make it new.
 */
export const fingerprintLines = (report: Report): ReadonlyArray<string> => {
  const lines = new Set<string>()
  for (const c of report.checks) {
    if (c.advisory || c.status !== "failed" || c.failedBefore) continue
    lines.add(`gate ${c.check} ${c.status}`)
    for (const f of c.failures ?? []) if (!f.endsWith("(fails on the base too)")) lines.add(`test ${c.check} ${testId(f)}`)
  }
  for (const v of report.violations) lines.add(`violation ${v.check} ${v.ruleId} ${v.path ?? ""}`.trimEnd())
  for (const r of report.ratchets) if (r.regressed) lines.add(`ratchet ${r.metric} ${r.file ?? ""}`.trimEnd())
  for (const f of report.integrity.findings) if (f.kind !== "flag") lines.add(`integrity ${f.kind} ${f.check} ${f.path ?? ""}`.trimEnd())
  for (const n of report.decision.nominations) if (n.blocking) lines.add(`rule ${n.rule}`)
  return [...lines].sort()
}

export const fingerprintOf = (lines: ReadonlyArray<string>) => sha256(lines.join("\n"))

/** The stored record as an attempt finds it. */
export type Previous =
  | { readonly kind: "fresh" }
  | { readonly kind: "ok"; readonly record: AttemptRecord }
  | { readonly kind: "untrusted"; readonly state: "missing" | "corrupt" }

export interface Attempt {
  readonly fingerprint: string
  readonly findings: ReadonlyArray<string>
  readonly reasons: ReadonlyArray<string>
}

/**
 * The record after one more blocked stop. Pure: the same previous record,
 * attempt and limits always give the same result. A missing or corrupt
 * record counts as already at both limits on these very findings.
 */
export const nextAttempt = (branch: string, previous: Previous, attempt: Attempt, limits: AttemptLimits): AttemptRecord => {
  const prev = previous.kind === "ok"
    ? { ...previous.record.attempts, fingerprint: previous.record.fingerprint }
    : previous.kind === "fresh"
    ? { unchanged: 0, total: 0, fingerprint: "" }
    : { ...limits, fingerprint: attempt.fingerprint }
  const unchanged = prev.fingerprint === attempt.fingerprint ? prev.unchanged + 1 : 1
  const total = prev.total + 1
  return {
    version: 1,
    status: unchanged > limits.unchanged || total > limits.total ? "exhausted" : "blocked",
    branch,
    attempts: { unchanged, total },
    limits: { unchanged: limits.unchanged, total: limits.total },
    fingerprint: attempt.fingerprint,
    findings: [...attempt.findings],
    reasons: [...attempt.reasons],
    state: previous.kind === "untrusted" ? previous.state : "ok",
  }
}

/** The record while the agent's `report_blocked` still matches: waiting on the owner, counts kept as they were. */
export const reportedBlocked = (branch: string, previous: Previous, attempt: Attempt, limits: AttemptLimits, reason: string): AttemptRecord => {
  const base = previous.kind === "ok" ? previous.record.attempts : previous.kind === "fresh" ? { unchanged: 0, total: 0 } : limits
  return {
    version: 1,
    status: "reported-blocked",
    branch,
    attempts: { unchanged: base.unchanged, total: base.total },
    limits: { unchanged: limits.unchanged, total: limits.total },
    // Kept from the record, so the next counted attempt continues from it.
    fingerprint: previous.kind === "ok" ? previous.record.fingerprint : previous.kind === "fresh" ? "" : attempt.fingerprint,
    findings: [...attempt.findings],
    reasons: [...attempt.reasons],
    state: previous.kind === "untrusted" ? previous.state : "ok",
    reportedReason: reason,
  }
}

const whyExhausted = (r: AttemptRecord) =>
  r.state === "missing"
    ? "its attempt record was missing, which counts as every attempt used"
    : r.state === "corrupt"
    ? "its attempt record was unreadable or didn't match its witness, which counts as every attempt used"
    : r.attempts.unchanged > r.limits.unchanged
    ? `blocked ${r.limits.unchanged} times in a row on the same findings`
    : `blocked ${r.limits.total} times on this branch`

/** The one line an exhausted stop prints. */
export const exhaustedLine = (r: AttemptRecord) =>
  `Gauntlet: exhausted on ${r.branch} (${whyExhausted(r)}). The change still fails its checks; details: gauntlet hook status --json`

/** What a blocked stop adds to the hook's reason: where the agent stands, and a warning before the last block. */
export const attemptNote = (r: AttemptRecord) => {
  const lines = [`Gauntlet attempt ${r.attempts.unchanged} of ${r.limits.unchanged} on these findings, ${r.attempts.total} of ${r.limits.total} on this branch.`]
  if (r.attempts.total >= r.limits.total) {
    lines.push("If your next stop is blocked again, Gauntlet lets you stop as exhausted. That is still a failure: say so plainly in your final message, with what blocks the change.")
  } else if (r.attempts.unchanged >= r.limits.unchanged) {
    lines.push("If your next stop finds the same, Gauntlet lets you stop as exhausted. That is still a failure: say so plainly in your final message, with what blocks the change.")
  }
  return lines.join(" ")
}

// ---------- the store ----------

const REF_PREFIX = "refs/gauntlet/attempts"
const hex = (branch: string) => Buffer.from(branch, "utf8").toString("hex")
const unhex = (h: string) => Buffer.from(h, "hex").toString("utf8")

const gitIn = (repo: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    return yield* (yield* ProcessRunner).run({ command: "git", args, cwd: repo })
  })

const gitOut = (repo: string, args: ReadonlyArray<string>) =>
  gitIn(repo, args).pipe(Effect.flatMap((r) => (r.exitCode === 0 ? Effect.succeed(r.stdout.trim()) : Effect.fail(new AttemptStoreFailed({ reason: `git ${args.join(" ")}: ${r.stderr.trim()}` })))))

export class AttemptStoreFailed extends Data.TaggedError("AttemptStoreFailed")<{ readonly reason: string }> {}

/** The git directory every worktree of the repository shares. */
export const commonDir = (repo: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return path.resolve(repo, yield* gitOut(repo, ["rev-parse", "--git-common-dir"]))
  })

/** The worktree that holds `cwd`: what the hooks judge (a subagent's own worktree, not the repository's root). */
export const worktreeOf = (cwd: string) =>
  Effect.gen(function*() {
    return yield* (yield* Git).topLevel(cwd)
  }).pipe(Effect.orElseSucceed(() => cwd))

/** The branch attempts are counted on: the checked-out branch, or `detached:<worktree>`. */
export const attemptBranch = (repo: string) =>
  Effect.gen(function*() {
    const branch = yield* gitIn(repo, ["symbolic-ref", "-q", "--short", "HEAD"])
    if (branch.exitCode === 0 && branch.stdout.trim() !== "") return branch.stdout.trim()
    const gitDir = yield* (yield* Git).gitDir(repo)
    const linked = gitDir.match(/\/worktrees\/([^/]+)\/?$/)
    return `detached:${linked ? linked[1] : "main"}`
  })

/** Where a branch's record and its witness live. */
export const attemptLocation = (repo: string, branch: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const dir = path.join(yield* commonDir(repo), "gauntlet", "attempts")
    return { dir, file: path.join(dir, `${hex(branch)}.json`), ref: `${REF_PREFIX}/${hex(branch)}` }
  })

const refTarget = (repo: string, ref: string) =>
  gitIn(repo, ["rev-parse", "-q", "--verify", `${ref}^{blob}`]).pipe(Effect.map((r) => (r.exitCode === 0 ? Option.some(r.stdout.trim()) : Option.none<string>())))

/**
 * The stored record for a branch. Fresh only when neither the file nor its
 * witness exists; anything else short of a match is untrusted.
 */
export const readAttempts = (repo: string, branch: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = yield* attemptLocation(repo, branch)
    const exists = yield* fs.exists(at.file).pipe(Effect.orElseSucceed(() => true))
    const witness = yield* refTarget(repo, at.ref)
    if (!exists && Option.isNone(witness)) return { kind: "fresh" } as Previous
    if (!exists) return { kind: "untrusted", state: "missing" } as Previous
    if (Option.isNone(witness)) return { kind: "untrusted", state: "corrupt" } as Previous
    const blob = yield* gitOut(repo, ["hash-object", "--", at.file]).pipe(Effect.option)
    const text = yield* fs.readFileString(at.file).pipe(Effect.option)
    const record = Option.flatMap(text, decodeRecord)
    if (Option.isNone(blob) || blob.value !== witness.value || Option.isNone(record) || record.value.branch !== branch) return { kind: "untrusted", state: "corrupt" } as Previous
    return { kind: "ok", record: record.value } as Previous
  }).pipe(Effect.orElseSucceed((): Previous => ({ kind: "untrusted", state: "corrupt" })))

/** Writes the record, then its witness. A crash between the two leaves a mismatch, which counts as at the limits. */
export const writeAttempts = (repo: string, record: AttemptRecord) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = yield* attemptLocation(repo, record.branch)
    yield* fs.makeDirectory(at.dir, { recursive: true })
    yield* fs.writeFileString(at.file, `${JSON.stringify(record, null, 2)}\n`)
    const blob = yield* gitOut(repo, ["hash-object", "-w", "--", at.file])
    yield* gitOut(repo, ["update-ref", at.ref, blob])
  })

/** Forgets a branch's attempts: it passed, or a person reset it. The witness goes first, so a crash leaves an untrusted file, never a fresh start. */
export const clearAttempts = (repo: string, branch: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = yield* attemptLocation(repo, branch)
    if (Option.isSome(yield* refTarget(repo, at.ref))) yield* gitOut(repo, ["update-ref", "-d", at.ref])
    yield* fs.remove(at.file, { force: true })
  })

/** One branch's outcome as the hooks last recorded it, for `hook status` and the MCP resource. */
export type AttemptView =
  | AttemptRecord
  | { readonly branch: string; readonly state: "missing" | "corrupt" }

/** Every branch with a record or a witness, sorted by branch. Untrusted ones are listed with their state, never left out. */
export const listAttempts = (repo: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const at = yield* attemptLocation(repo, "")
    const files = (yield* fs.readDirectory(at.dir).pipe(Effect.orElseSucceed(() => []))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
    const refs = (yield* gitOut(repo, ["for-each-ref", "--format=%(refname)", REF_PREFIX]).pipe(Effect.orElseSucceed(() => "")))
      .split("\n").filter(Boolean).map((r) => r.slice(REF_PREFIX.length + 1))
    const branches = [...new Set([...files, ...refs].filter((h) => /^([0-9a-f]{2})+$/.test(h)).map(unhex))].sort()
    const views: AttemptView[] = []
    for (const branch of branches) {
      const found = yield* readAttempts(repo, branch)
      if (found.kind === "ok") views.push(found.record)
      else if (found.kind === "untrusted") views.push({ branch, state: found.state })
    }
    return views
  })
