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

/** What the agent is told once its report is recorded. */
export const BLOCKED_ACK = (reason: string) =>
  `Recorded: ${reason}\nStop here and tell the person what you need and why. Don't work around it. Gauntlet will let you finish; the change needs a person's review. Any further edit makes this report stale.`
