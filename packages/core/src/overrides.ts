import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import { Git, type GitFailure } from "./git.ts"

// Overrides (ADR 0014). Recorded as git notes on the head commit; they never
// change the tier. Only the GitHub integration can honour one, after checking
// the approver's review on that exact commit. Locally they are shown, never
// honoured.

export const OVERRIDES_REF = "gauntlet-overrides"

export const OverrideRecord = Schema.Struct({
  headSha: Schema.String,
  irHash: Schema.String,
  reason: Schema.String,
  approver: Schema.String,
  requestedBy: Schema.String,
  /** The commit whose policy `irHash` is: the pull request's base, which CI judges with. Older notes don't have it. */
  policySha: Schema.optionalKey(Schema.String),
})
export type OverrideRecord = typeof OverrideRecord.Type

/** The policy an override was recorded against, for a person: its commit when known, and its IR hash. */
export const recordedAgainst = (o: OverrideRecord) =>
  o.policySha !== undefined ? `the policy at ${o.policySha.slice(0, 12)} (IR ${o.irHash.slice(0, 12)})` : `policy IR ${o.irHash.slice(0, 12)}`

/**
 * Overrides for this head that can't count because they name another policy
 * than the one the change is judged with. Only the hash is compared, never
 * loosened: this is for saying why, not for honouring them.
 */
export const mismatchedOverrides = (overrides: ReadonlyArray<OverrideRecord>, head: string, irHash: string) =>
  overrides.filter((o) => o.headSha === head && o.irHash !== irHash)

export class OverrideInvalid extends Data.TaggedError("OverrideInvalid")<{ readonly reason: string }> {}

export class Overrides extends Context.Service<Overrides, {
  readonly record: (repo: string, override: OverrideRecord) => Effect.Effect<void, GitFailure | OverrideInvalid>
  readonly forHead: (repo: string, head: string) => Effect.Effect<ReadonlyArray<OverrideRecord>, GitFailure>
}>()("@gauntlet/core/Overrides") {}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(OverrideRecord))

const APPROVER = /^@[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)?$/

export const OverridesLive = Layer.effect(
  Overrides,
  Effect.gen(function*() {
    const git = yield* Git
    return {
      record: (repo, o) =>
        Effect.gen(function*() {
          if (o.reason.trim().length < 10) return yield* new OverrideInvalid({ reason: "give a reason of at least 10 characters" })
          if (!APPROVER.test(o.approver)) return yield* new OverrideInvalid({ reason: `approver must look like @user or @org/team, not '${o.approver}'` })
          yield* git.appendNote(repo, OVERRIDES_REF, o.headSha, JSON.stringify(Schema.encodeSync(OverrideRecord)(o)))
        }),
      forHead: (repo, head) =>
        git.readNote(repo, OVERRIDES_REF, head).pipe(
          Effect.map((note) =>
            Option.match(note, {
              onNone: () => [],
              onSome: (text) =>
                text.split("\n").flatMap((line) =>
                  Option.match(decodeLine(line), {
                    onNone: () => [],
                    // A note copied onto another commit doesn't count for this one.
                    onSome: (o) => (o.headSha === head ? [o] : []),
                  })
                ),
            })
          ),
        ),
    }
  }),
)
