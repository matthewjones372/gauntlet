import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { Git } from "./git.ts"

// `report_blocked`: the agent's legitimate way out when a task can't be done
// without changing protected tests or policy. The report is kept for the exact
// working-tree state it was made on (a tree hash), so editing anything
// afterwards makes it stale. While it matches, checks nominate review with the
// agent's reason and the Stop hook lets the agent finish, so a person decides.
// It can only add caution, never loosen anything.

export const BlockedReport = Schema.Struct({
  reason: Schema.String,
  tree: Schema.String,
  at: Schema.String,
  paths: Schema.Array(Schema.String),
  /** The blocking findings when the report was first checked: what the owner is now deciding. */
  blocking: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type BlockedReport = typeof BlockedReport.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(BlockedReport))

const file = (repo: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return path.join(yield* (yield* Git).gitDir(repo), "gauntlet", "blocked.json")
  })

export const recordBlocked = (repo: string, report: { readonly reason: string; readonly paths: ReadonlyArray<string>; readonly at: string }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { tree } = yield* (yield* Git).snapshot(repo)
    const target = yield* file(repo)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    const record: BlockedReport = { reason: report.reason, tree, at: report.at, paths: [...report.paths].sort() }
    yield* fs.writeFileString(target, `${JSON.stringify(record, null, 2)}\n`)
    return record
  })

/** The blocked report made on exactly this tree, if any. */
export const blockedFor = (repo: string, tree: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(yield* file(repo)).pipe(Effect.option)
    return Option.filter(Option.flatMap(text, decode), (r) => r.tree === tree)
  })

/** The latest blocked report, whatever tree it was made on. */
export const latestBlocked = (repo: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(yield* file(repo)).pipe(Effect.option)
    return Option.flatMap(text, decode)
  })

/**
 * What makes two blocks "the same": each blocking nomination's rule and its
 * full reason, which names the check, the test, the finding and its file and
 * line. Any change in what blocks, even a count or a line, is a different set.
 */
export const blockingSet = (decision: { readonly nominations: ReadonlyArray<{ readonly blocking: boolean; readonly rule: string; readonly reason: string }> }): ReadonlyArray<string> =>
  [...new Set(decision.nominations.filter((n) => n.blocking).map((n) => `${n.rule}: ${n.reason}`))].sort()

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Whether a block is the one the agent already reported, so the Stop hook
 * needn't raise it again while the owner works (none: raise it). The first
 * check on the reported tree records its blocking set. After that it's the
 * same block while the blocking set is unchanged and the tree differs from the
 * reported one only in files the agent can't edit (protected files other than
 * tests): the owner's own steps. Any other edit makes the report stale, as
 * before, and a new or different finding is never hidden.
 */
export const knownBlock = (
  repo: string,
  current: { readonly tree: string; readonly blocking: ReadonlyArray<string> },
  ownerPath: (path: string) => boolean,
) =>
  Effect.gen(function*() {
    const found = yield* latestBlocked(repo)
    if (Option.isNone(found)) return Option.none<{ readonly reason: string; readonly exact: boolean }>()
    const report = found.value
    const blocking = [...current.blocking].sort()
    if (report.tree === current.tree && report.blocking === undefined) {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(yield* file(repo), `${JSON.stringify({ ...report, blocking }, null, 2)}\n`)
      return Option.some({ reason: report.reason, exact: true })
    }
    if (report.blocking === undefined || !sameSet(report.blocking, blocking)) return Option.none()
    if (report.tree === current.tree) return Option.some({ reason: report.reason, exact: true })
    // A tree git can no longer read (pruned) can't be compared: treat the report as stale.
    const changes = yield* (yield* Git).diff(repo, report.tree, current.tree).pipe(Effect.option)
    if (Option.isNone(changes)) return Option.none()
    const ownersOnly = changes.value.every((c) => ownerPath(c.path) && (c.oldPath === undefined || ownerPath(c.oldPath)))
    return ownersOnly ? Option.some({ reason: report.reason, exact: false }) : Option.none()
  })

/** What the agent is told once its report is recorded. */
export const BLOCKED_ACK = (reason: string) =>
  `Recorded: ${reason}\nStop here and tell the person what you need and why. Don't work around it. Gauntlet will let you finish; the change needs a person's review. Any further edit makes this report stale.`
