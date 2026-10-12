import { Data, Effect, Option, Schema } from "effect"
import { Git } from "./git.ts"

// Grants (spec 0015). The owner lets the agent change protected paths for one
// pull request: `gauntlet grant` records a git note on the pull request's head
// commit. Claude Code's hook then allows those edits on that branch, and the
// check judges such a change as owner tier, naming the grant. A grant only
// ever raises the tier in CI; it never approves, overrides or restores less.

export const GRANTS_REF = "gauntlet-grants"

export const GrantRecord = Schema.Struct({
  pr: Schema.Number,
  /** The pull request's branch: the hook allows the edits there only. */
  branch: Schema.String,
  /** The pull request's head when the owner granted it; the grant holds for commits built on it. */
  headSha: Schema.String,
  paths: Schema.Array(Schema.String),
  reason: Schema.String,
  approver: Schema.String,
})
export type GrantRecord = typeof GrantRecord.Type

export class GrantInvalid extends Data.TaggedError("GrantInvalid")<{ readonly reason: string }> {}

/** Why a path can't be granted, or undefined. Exact repository paths only: never a pattern, never git's own files. */
export const grantPathProblem = (path: string): string | undefined => {
  if (path === ".git" || path.startsWith(".git/")) return "a grant can't name .git/ (where approvals and overrides live)"
  if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === "")) return `give each path from the repository's root, without '..': '${path}'`
  if (/[*?[\]{}]/.test(path)) return `name each file: a grant doesn't take patterns ('${path}')`
  return undefined
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(GrantRecord))

/** Records a grant as a note on the head it was given at. */
export const recordGrant = (repo: string, g: GrantRecord) =>
  Effect.gen(function*() {
    if (g.reason.trim().length < 10) return yield* new GrantInvalid({ reason: "give a reason of at least 10 characters" })
    if (g.paths.length === 0) return yield* new GrantInvalid({ reason: "name at least one path" })
    const problem = g.paths.map(grantPathProblem).find((p) => p !== undefined)
    if (problem !== undefined) return yield* new GrantInvalid({ reason: problem })
    yield* (yield* Git).appendNote(repo, GRANTS_REF, g.headSha, JSON.stringify(Schema.encodeSync(GrantRecord)(g)))
  })

/**
 * The grants a change carries: those given at a commit the head is built on
 * and the base isn't, so a grant applies to the one pull request it was given
 * for and lapses once that merges. A note copied onto another commit doesn't count.
 */
export const grantsBetween = (repo: string, base: ReadonlyArray<string>, head: string) =>
  Effect.gen(function*() {
    const git = yield* Git
    const out: GrantRecord[] = []
    for (const commit of yield* git.notedCommits(repo, GRANTS_REF)) {
      if (!(yield* git.isAncestor(repo, commit, head))) continue
      let merged = false
      for (const b of base) if (yield* git.isAncestor(repo, commit, b)) merged = true
      if (merged) continue
      const note = yield* git.readNote(repo, GRANTS_REF, commit)
      if (Option.isNone(note)) continue
      for (const line of note.value.split("\n")) {
        const g = decodeLine(line)
        if (Option.isSome(g) && g.value.headSha === commit) out.push(g.value)
      }
    }
    return out
  })

/** The grant that covers a path, if one does. */
export const grantFor = (grants: ReadonlyArray<GrantRecord>, path: string) => grants.find((g) => g.paths.includes(path))
